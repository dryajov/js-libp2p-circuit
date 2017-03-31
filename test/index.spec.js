/* eslint-env mocha */
'use strict'

const PeerInfo = require('peer-info')
const series = require('async/series')
const pull = require('pull-stream')
const Libp2p = require('libp2p')

const TCP = require('libp2p-tcp')
const WS = require('libp2p-websockets')
const spdy = require('libp2p-spdy')
const multiplex = require('libp2p-multiplex')
const secio = require('libp2p-secio')

const expect = require('chai').expect

class TestNode extends Libp2p {
  constructor (peerInfo, transports, muxer, options) {
    options = options || {}

    const modules = {
      transport: transports,
      connection: {
        muxer: [muxer],
        crypto: [
          secio
        ]
      },
      discovery: []
    }
    super(modules, peerInfo, null, options)
  }
}

describe('test relay', function () {
  describe('test connecting over any relay', function () {
    this.timeout(500000)

    let srcNode
    let dstNode
    let relayNode

    let srcPeer
    let dstPeer
    let relayPeer

    let portBase = 9000 // TODO: randomize or mock sockets

    function setUpNodes (muxer, cb) {
      series([
        (cb) => {
          PeerInfo.create((err, info) => {
            relayPeer = info
            relayPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}`)
            relayPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}/ws`)
            relayNode = new TestNode(relayPeer, [new TCP(), new WS()], muxer, {
              circuit: {
                hop: true
              }
            })

            console.log(`Relay peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        },
        (cb) => {
          PeerInfo.create((err, info) => {
            srcPeer = info
            srcPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}`)
            srcNode = new TestNode(srcPeer, [new TCP()], muxer)

            console.log(`Src peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        },
        (cb) => {
          PeerInfo.create((err, info) => {
            dstPeer = info
            dstPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}/ws`)
            dstNode = new TestNode(dstPeer, [new WS()], muxer)

            console.log(`Dst peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        }
      ], cb)
    }

    function startNodes (muxer, done) {
      series([
        (cb) => setUpNodes(muxer, cb),
        (cb) => {
          relayNode.start(cb)
        },
        (cb) => {
          srcNode.start(cb)
        },
        (cb) => {
          dstNode.start(cb)
        },
        // This is needed because its difficult to time when the relay has been added to the circuit
        (cb) => srcNode.swarm.transports['Circuit'].addRelayPeer(relayNode.peerInfo, cb),
        (cb) => dstNode.swarm.transports['Circuit'].addRelayPeer(relayNode.peerInfo, cb),
      ], done)
    }

    function stopNodes (done) {
      series([
        (cb) => {
          srcNode.stop(cb)
        },
        (cb) => {
          dstNode.stop(cb)
        },
        (cb) => {
          relayNode.stop(cb)
        }
      ], () => done()) // TODO: pass err to done once we figure out why spdy is throwing on stop
    }

    function reverse (protocol, conn) {
      pull(
        conn,
        pull.map((data) => {
          return data.toString().split('').reverse().join('')
        }),
        conn
      )
    }

    function dialAndRevers (vals, done) {
      srcNode.handle('/ipfs/reverse/1.0.0', reverse)

      dstNode.dialByPeerInfo(srcNode.peerInfo, '/ipfs/reverse/1.0.0', (err, conn) => {
        if (err) return done(err)

        pull(
          pull.values(['hello']),
          conn,
          pull.collect((err, data) => {
            if (err) return done(err)

            data.forEach((val, i) => {
              expect(val.toString()).to.equal(vals[i].split('').reverse().join(''))
            })

            dstNode.hangUpByPeerInfo(srcPeer, done)
          }))
      })
    }

    describe(`circuit over spdy muxer`, function () {
      beforeEach(function (done) {
        startNodes(spdy, done)
      })

      afterEach(function circuitTests (done) {
        stopNodes(done)
      })

      it('should dial to a node over a relay and write a value', function (done) {
        dialAndRevers(['hello'], done)
      })

      it('should dial to a node over a relay and write several values', function (done) {
        dialAndRevers(['hello', 'hello1', 'hello2', 'hello3'], done)
      })
    })

    describe(`circuit over multiplex muxer`, function () {
      beforeEach(function (done) {
        startNodes(multiplex, done)
      })

      afterEach(function circuitTests (done) {
        stopNodes(done)
      })

      it('should dial to a node over a relay and write a value', function (done) {
        dialAndRevers(['hello'], done)
      })

      it('should dial to a node over a relay and write several values', function (done) {
        dialAndRevers(['hello', 'hello1', 'hello2', 'hello3'], done)
      })
    })
  })
  describe('test listening on relay address', function () {
    this.timeout(500000)

    let srcNode
    let dstNode
    let relayNode1
    let relayNode2

    let relayPeer1
    let relayPeer2
    let srcPeer
    let dstPeer

    let portBase = 9000 // TODO: randomize or mock sockets

    function setUpNodes (muxer, cb) {
      series([
        (cb) => {
          PeerInfo.create((err, info) => {
            relayPeer1 = info
            relayPeer1.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}`)
            relayPeer1.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}/ws`)
            relayNode1 = new TestNode(relayPeer1, [new TCP(), new WS()], muxer, {
              circuit: {
                hop: {
                  enable: true
                }
              }
            })

            console.log(`Relay1 peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        },
        (cb) => {
          PeerInfo.create((err, info) => {
            relayPeer2 = info
            relayPeer2.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}`)
            relayPeer2.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}/ws`)
            relayNode2 = new TestNode(relayPeer2, [new TCP(), new WS()], muxer, {
              circuit: {
                hop: {
                  enable: true
                }
              }
            })

            console.log(`Relay2 peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        },
        (cb) => {
          PeerInfo.create((err, info) => {
            srcPeer = info
            srcPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}`)
            srcPeer.multiaddr
              .add(`/ipfs/${relayPeer1.id.toB58String()}/p2p-circuit`)
            srcNode = new TestNode(srcPeer, [new TCP()], muxer)
            srcNode.peerBook.put(relayPeer1)
            srcNode.peerBook.put(relayPeer2)

            console.log(`srcNode peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        },
        (cb) => {
          PeerInfo.create((err, info) => {
            dstPeer = info
            dstPeer.multiaddr.add(`/ip4/0.0.0.0/tcp/${portBase++}/ws`)
            dstPeer.multiaddr
              .add(`/ipfs/${relayPeer1.id.toB58String()}/p2p-circuit`)
            dstNode = new TestNode(dstPeer, [new WS()], muxer)
            srcNode.peerBook.put(relayPeer1)
            srcNode.peerBook.put(relayPeer2)

            console.log(`dstNode peer id: ${info.id.toB58String()}`)
            cb(err)
          })
        }
      ], cb)
    }

    function startNodes (muxer, done) {
      series([
        (cb) => setUpNodes(muxer, cb),
        (cb) => {
          relayNode1.start(cb)
        },
        (cb) => {
          relayNode2.start(cb)
        },
        (cb) => {
          dstNode.start(cb)
        },
        (cb) => {
          srcNode.start(cb)
        },
        (cb) => srcNode.swarm.transports['Circuit'].addRelayPeer(relayNode1.peerInfo, cb),
        (cb) => srcNode.swarm.transports['Circuit'].addRelayPeer(relayNode2.peerInfo, cb),
        (cb) => dstNode.swarm.transports['Circuit'].addRelayPeer(relayNode1.peerInfo, cb),
        (cb) => dstNode.swarm.transports['Circuit'].addRelayPeer(relayNode2.peerInfo, cb)
      ], done)
    }

    function stopNodes (done) {
      series([
        (cb) => {
          srcNode.stop(cb)
        },
        (cb) => {
          dstNode.stop(cb)
        },
        (cb) => {
          relayNode1.stop(cb)
        },
        (cb) => {
          relayNode1.stop(cb)
        },
        (cb) => {
          relayNode2.stop(cb)
        }
      ], () => done()) // TODO: pass err to done once we figure out why spdy is throwing on stop
    }

    function reverse (protocol, conn) {
      pull(
        conn,
        pull.map((data) => {
          return data.toString().split('').reverse().join('')
        }),
        conn
      )
    }

    function dialAndRevers (vals, done) {
      srcNode.handle('/ipfs/reverse/1.0.0', reverse)

      dstNode.dialByPeerInfo(srcNode.peerInfo, '/ipfs/reverse/1.0.0', (err, conn) => {
        if (err) return done(err)

        pull(
          pull.values(['hello']),
          conn,
          pull.collect((err, data) => {
            if (err) return done(err)

            data.forEach((val, i) => {
              expect(val.toString()).to.equal(vals[i].split('').reverse().join(''))
            })

            dstNode.hangUpByPeerInfo(srcNode.peerInfo, done)
          }))
      })
    }

    describe(`circuit over spdy muxer`, function () {
      beforeEach(function (done) {
        startNodes(spdy, done)
      })

      afterEach(function circuitTests (done) {
        stopNodes(done)
      })

      it('should dial to a node over a relay and write a value', function (done) {
        dialAndRevers(['hello'], done)
      })

      it('should dial to a node over a relay and write several values', function (done) {
        dialAndRevers(['hello', 'hello1', 'hello2', 'hello3'], done)
      })
    })

    describe(`circuit over multiplex muxer`, function () {
      beforeEach(function (done) {
        startNodes(multiplex, done)
      })

      afterEach(function circuitTests (done) {
        stopNodes(done)
      })

      it('should dial to a node over a relay and write a value', function (done) {
        dialAndRevers(['hello'], done)
      })

      it('should dial to a node over a relay and write several values', function (done) {
        dialAndRevers(['hello', 'hello1', 'hello2', 'hello3'], done)
      })
    })
  })
})
