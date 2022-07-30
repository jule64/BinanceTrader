

const express = require("express");
const {WebsocketClient, RestClient} = require("ftx-api");
const app = express();

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);


const apikeys = require('./apikeys/apikeys.json');
if(apikeys.key === "" || apikeys.secret === "") {
    console.info("ERROR: Missing API keys.  There are no api key/secret in /apikeys/apikeys.json");
    process.exit();
}

const ftxWS = new WebsocketClient({key: apikeys.key, secret: apikeys.secret });
const ftxRestCli = new RestClient(apikeys.key, apikeys.secret);


let subscribedTickers = []

app.use(express.static(__dirname));


const upalerts = new Map();
const downalerts = new Map();

var Deque = require("collections/deque");
const tickersToLast10VolQueues = new Map();
const VOLUMES_QUEUE_SIZE = 20

async function updateBalances(tblTickers, ftxRestCli, sio) {
    const balances = await ftxRestCli.getBalances();
    const coinToBalance =  balances.result.reduce((p, c) => {
        p.set(c.coin,c);
        return p;}, new Map());

    const balancesMap = tblTickers.map(t => [t, coinToBalance.get(t.split('/')[0])]);

    if(balancesMap.length === 1){
        sio.emit('balances:singleupdate', balancesMap);
    } else {
        sio.emit('balances:update', balancesMap);
    }
}

function getAlertsForPrice(priceUpdate) {
    const uplevel = upalerts.get(priceUpdate.ticker);
    const downlevel = downalerts.get(priceUpdate.ticker);

    alertObj = {ticker: null, direction: null};
    if (uplevel != null && priceUpdate.priceObj.price > uplevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'up';
    } else if (downlevel != null && priceUpdate.priceObj.price < downlevel) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = 'down';
    } else if (uplevel != null || downlevel != null) {
        alertObj.ticker = priceUpdate.ticker;
        alertObj.direction = null; // means not triggered or untriggered (from up or down)
    }
    return alertObj;
}

function initFTXOps(sio, ws, rc) {

      sio.on('connection', (socket) => {
        socket.on('price:subs', function(tickersRequested) {


          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v));
          console.log('subscribing to live price updates for ', tickersNotSubscribedYet);

          topics = tickersNotSubscribedYet.map((v) => {
              return {'channel': 'trades',
              'market': v}
          })
          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
          ws.subscribe(topics);

        });

        socket.on('orders:new-morder', (marketOrder) => {
            console.info('received market order', marketOrder);
            rc.placeOrder(marketOrder).then(
                resp => {
                    console.info('order executed', resp);
                    updateBalances([resp.result.market], rc, sio);
                    },
                resp =>  console.warn('order execution failed', resp)
            );
        });

        socket.on('alerts:up-alert', (alertObj) => {
            upalerts.set(alertObj.ticker, alertObj.alertlevel)
        });
        socket.on('alerts:down-alert', (alertObj) => {
            downalerts.set(alertObj.ticker, alertObj.alertlevel)
        });
        socket.on('alerts:cancel-alerts', (ticker) => {
            upalerts.delete(ticker)
            downalerts.delete(ticker)
        });

        socket.on('balances:get', async (tblTickers) => {
            try {
                console.info('updating balances for', tblTickers);
                updateBalances(tblTickers, rc, sio);

            } catch (e) {
                console.log(e);
            }
            });
        });




    ws.on('response', response => {
        console.log('response', response);
    });

    ws.on('update', data => {
        // this is still printing even with debug level set to false..
        // console.debug(`update:${data.type}`, data);
        if(data.type === "subscribed") {
            console.log('received a subscription confirmation for', data);
        } else if (data.type === "update") {
            if(data.channel === "trades") {
                const priceUpdate = handlePriceUpdate(data);
                const alerts = getAlertsForPrice(priceUpdate);
                sio.emit('price:update', [priceUpdate, alerts]);


            } else if(data.channel === "fills") {
                console.warn('fills events not handled yet');

            }
        }
    })
}

function handlePriceUpdate(data) {

    const ticker = data.market;
    const trades = data.data;
    const largestTrade = extractLargestTrade(trades, ticker);
    const last10VolumesQ = updateAndReturnLast10VolumesMap(trades, ticker);
    const sumLast10Volumes = last10VolumesQ.reduce((r, v) => r + v, 0);

    priceUpdate = {
        ticker: ticker,
        priceObj: largestTrade,
        tradeVolume: sumLast10Volumes
    }

    return priceUpdate;
}

function extractLargestTrade(trades) {
    return trades.sort((a, b) =>
            a.size - b.size
    ).slice(-1)[0]
}

function updateAndReturnLast10VolumesMap(trades, ticker) {

    var volumeQ = tickersToLast10VolQueues.get(ticker);
    if(volumeQ === undefined) {
        volumeQ = new Deque();
        tickersToLast10VolQueues.set(ticker, volumeQ);
    }

    trades.forEach(t => {
        volumeQ.push(t.size * t.price);
        if(volumeQ.length > VOLUMES_QUEUE_SIZE) {
            volumeQ.shift();
        }
    });
    return volumeQ;
}

const appPort = 5001
http.listen(appPort, () => {
  initFTXOps(socketio, ftxWS, ftxRestCli)
  console.info(`Open browser on http://localhost:${appPort}`);
});

