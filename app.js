// import required modules
import express from 'express'
const app = express()

import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
const __dirname = path.resolve()

import {
    Server
} from 'socket.io'
import mediasoup from 'mediasoup'

// define a route for the app
app.get('/', (req, res) => {
    res.send('Hello World!')
})

// serve static files from the public directory
app.use('/sfu', express.static(path.join(__dirname, 'public')))

// set options for HTTPS server
const options = {
    key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
    cert: fs.readFileSync('./server/ssl/cert.pm', 'utf-8')
}

// create a HTTPS server using the options and the app
const httpsServer = https.createServer(options, app)

// listen on port 3000 for incoming connections
httpsServer.listen(3000, () => {
    console.log('listening on port: ' + 3000)
})

// create a new Socket.IO instance using the HTTPS server
const io = new Server(httpsServer)

// create a new namespace for Socket.IO
const peers = io.of('/mediasoup')

let worker
let router
let producerTransport
let consumerTransport
let producer
let consumer

// function to create a mediasoup worker
const createWorker = async () => {
    // create the worker with given options
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 2020,
    })
    console.log(`worker pid ${worker.pid}`)

    // handle worker death
    worker.on('died', error => {
        console.error('mediasoup worker has died')
        setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
    })

    // return the created worker
    return worker
}

// create the worker and assign it to the variable
worker = createWorker()

// define media codecs for the router
const mediaCodecs = [{
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
        },
    },
]

// handle connection events on the peers namespace
peers.on('connection', async socket => {
    console.log(socket.id)
    socket.emit('connection-success', {
        socketId: socket.id
    })

    // handle disconnection events on the socket
    socket.on('disconnect', () => {
        console.log('peer disconnected')
    })

    // create a router for the worker
    router = await worker.createRouter({
        mediaCodecs,
    })

    // handle getRtpCapabilities event
    socket.on('getRtpCapabilities', (callback) => {
        const rtpCapabilities = router.rtpCapabilities
        console.log('rtp Capabilities', rtpCapabilities)
        callback({
            rtpCapabilities
        })
    })

    // handle createWebRtcTransport event
    socket.on('createWebRtcTransport', async ({
        sender
    }, callback) => {
        console.log(`Is this a sender request? ${sender}`)
        if (sender)
            producerTransport = await createWebRtcTransport(callback)
        else
            consumerTransport = await createWebRtcTransport(callback)
    })

    // listen for 'transport-connect' event
    socket.on('transport-connect', async ({
        dtlsParameters // destructuring dtlsParameters object from event payload
    }) => {
        console.log('DTLS PARAMS... ', {
            dtlsParameters
        })
        await producerTransport.connect({
            dtlsParameters // pass dtlsParameters to producerTransport's connect method
        })
    })

    // listen for 'transport-produce' event
    socket.on('transport-produce', async ({
        kind, // destructuring kind from event payload
        rtpParameters, // destructuring rtpParameters from event payload
        appData // destructuring appData from event payload
    }, callback) => {
        producer = await producerTransport.produce({
            kind, // pass kind to producerTransport's produce method
            rtpParameters, // pass rtpParameters to producerTransport's produce method
        })

        console.log('Producer ID: ', producer.id, producer.kind)

        // listen for 'transportclose' event on producer object
        producer.on('transportclose', () => {
            console.log('transport for this producer closed ')
            producer.close() // close producer object
        })

        callback({
            id: producer.id
        }) // invoke callback function with producer id
    })

    // listen for 'transport-recv-connect' event
    socket.on('transport-recv-connect', async ({
        dtlsParameters // destructuring dtlsParameters object from event payload
    }) => {
        console.log(`DTLS PARAMS: ${dtlsParameters}`)
        await consumerTransport.connect({
            dtlsParameters // pass dtlsParameters to consumerTransport's connect method
        })
    })

    // listen for 'consume' event
    socket.on('consume', async ({
        rtpCapabilities // destructuring rtpCapabilities object from event payload
    }, callback) => {
        try {
            if (router.canConsume({
                    producerId: producer.id,
                    rtpCapabilities
                })) {
                consumer = await consumerTransport.consume({
                    producerId: producer.id,
                    rtpCapabilities,
                    paused: true, // set paused option to true
                })

                // listen for 'transportclose' event on consumer object
                consumer.on('transportclose', () => {
                    console.log('transport close from consumer')
                })

                // listen for 'producerclose' event on consumer object
                consumer.on('producerclose', () => {
                    console.log('producer of consumer closed')
                })

                const params = {
                    id: consumer.id,
                    producerId: producer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                }

                callback({
                    params // invoke callback function with consumer params
                })
            }
        } catch (error) {
            console.log(error.message)
            callback({
                params: {
                    error: error
                }
            }) // invoke callback function with error object
        }
    })


    // listen for 'consumer-resume' event
    socket.on('consumer-resume', async () => {
        console.log('consumer resume')
        await consumer.resume() // resume consumer object
    })
})

// create a WebRtcTransport
const createWebRtcTransport = async (callback) => {
    try {
        const webRtcTransport_options = {
            listenIps: [{
                ip: '0.0.0.0', // replace with relevant IP address
                announcedIp: '127.0.0.1',
            }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        }

        let transport = await router.createWebRtcTransport(webRtcTransport_options)
        console.log(`transport id: ${transport.id}`)

        transport.on('dtlsstatechange', dtlsState => {
            if (dtlsState === 'closed') {
                transport.close()
            }
        })

        transport.on('close', () => {
            console.log('transport closed')
        })

        callback({
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        })

        return transport

    } catch (error) {
        console.log(error)
        callback({
            params: {
                error: error
            }
        })
    }
}