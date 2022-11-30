const express = require('express')
const cors = require('cors');
require('dotenv').config()
const jwt = require('jsonwebtoken');
const app = express()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);


// middleware - 
app.use(cors())
app.use(express.json())


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.xj7qmnz.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// get the token and verify - (middleWare)
const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access')
    }
    const token = authHeader.split(' ')[1]

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded
        next();
    })
}

async function run() {
    try {
        const appointmentOptionsCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');

        // NOTE: make sure you use verifyAdmin after verifyJWT - (middleware)
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail }
            const user = await usersCollection.findOne(query)

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        // get all data from database -
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date
            const query = {}
            const options = await appointmentOptionsCollection.find(query).toArray()
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray()

            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name)
                const bookedSlots = optionBooked.map(book => book.slot)
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots
            })
            res.send(options)
        })

        // post single data in database - 
        app.post('/bookings', async (req, res) => {
            const booking = req.body
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            const alreadyBooked = await bookingsCollection.find(query).toArray()

            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingsCollection.insertOne(booking)
            res.send(result)
        })

        // get specific data and token by user email -
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email
            const decodedEmail = req.decoded.email

            // verify user - 
            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email }
            const bookings = await bookingsCollection.find(query).toArray()
            res.send(bookings)
        })

        // post single user in database - 
        app.post('/users', async (req, res) => {
            const user = req.body
            const result = await usersCollection.insertOne(user)
            res.send(result)
        })

        // get all users from database - 
        app.get('/users', async (req, res) => {
            const query = {}
            const users = await usersCollection.find(query).toArray()
            res.send(users)
        })

        // post token, if the user exist - 
        app.get('/jwt', async (req, res) => {
            const email = req.query.email
            const query = { email: email }
            const user = await usersCollection.findOne(query)
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '5h' })
                return res.send({ accessToken: token })
            }
            res.status(403).send({ accessToken: '' })
        })

        // update (make user's admin) - 
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const filter = { _id: ObjectId(id) }
            const options = { upsert: true }
            const updateDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updateDoc, options)
            res.send(result);
        })

        // check admin by users email - 
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email
            const query = { email }
            const user = await usersCollection.findOne(query)
            res.send({ isAdmin: user?.role === 'admin' })
        })

        // get one field from database - 
        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointmentOptionsCollection.find(query).project({ name: 1 }).toArray()
            res.send(result)
        })

        // post doctors in database -
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body
            const result = await doctorsCollection.insertOne(doctor)
            res.send(result)
        })

        // get all doctors from database - 
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {}
            const doctors = await doctorsCollection.find(query).toArray()
            res.send(doctors)
        })

        // delete doctors from database - 
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const filter = { _id: ObjectId(id) }
            const result = await doctorsCollection.deleteOne(filter)
            res.send(result)
        })


        // temporary update price field on appointment options - 
        // app.get('/addPrice', async (req, res) => {
        //     const filter = {}
        //     const options = { upsert: true }
        //     const updateDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointmentOptionsCollection.updateMany(filter, updateDoc, options)
        //     res.send(result)
        // })


        // get specific bookings data by id - (for payment)
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const booking = await bookingsCollection.findOne(query)
            res.send(booking)
        })

        // post payment data (clientSecret) - 
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body
            const price = booking.price
            const amount = price * 100

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                "payment_method_types": [
                    "card"
                ],
            })

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // post payment data in database and update data in bookingsCollection -  
        app.post('/payments', async (req, res) => {
            const payment = req.body
            const result = await paymentsCollection.insertOne(payment)

            const id = payment.bookingId
            const filter = { _id: ObjectId(id) }
            const updateDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updatedResult = await bookingsCollection.updateOne(filter, updateDoc)

            res.send(result)
        })
    }
    finally {

    }
}
run().catch(console.log)

app.get('/', (req, res) => {
    res.send('Hello from Doctors Portal')
})

app.listen(port, () => {
    console.log(`Doctors Portal running on ${port}`)
})