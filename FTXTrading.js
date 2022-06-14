

const express = require("express")
const app = express()

const http = require('http').createServer(app);
const socketio = require('socket.io')(http);


console.log = function() {}

apicreds = {
    "KEY": "",
    "SECRET": ""
}
const {WebsocketClient, RestClient} = require("ftx-api");
const ftxWS = new WebsocketClient(apicreds)
const ftxRestCli = new RestClient(apicreds.KEY, apicreds.SECRET);

let subscribedTickers = []

app.use(express.static(__dirname))
app.get("/", (req, res) => {
  console.log('received get request');
  res.sendFile(__dirname + '/index.html');

});


const upalerts = new Map();
const downalerts = new Map();


async function updateBalances(tblTickers, ftxRestCli, sio) {
    const balances = await ftxRestCli.getBalances();
    const coinToBalance =  balances.result.reduce((p, c) => {
        p.set(c.coin,c);
        return p;}, new Map());
    sio.emit('balances:update', tblTickers.map(t => [t, coinToBalance.get(t.split('/')[0])]));
}

function initFTXOps(sio, ws, rc) {

      sio.on('connection', (socket) => {
        socket.on('price:subs', function(tickersRequested) {

          tickersNotSubscribedYet = tickersRequested.filter(v => !subscribedTickers.includes(v))

          topics = tickersNotSubscribedYet.map((v) => {
              return {'channel': 'trades',
              'market': v}
          })
          subscribedTickers = subscribedTickers.concat(tickersNotSubscribedYet);
          ws.subscribe(topics);
        });

        socket.on('orders:new-morder', (marketOrder) => {
            rc.placeOrder(marketOrder).then(
                resp => {
                    console.info(resp);
                    updateBalances([resp.result.market], rc, sio);
                    },
                resp => console.info(resp)
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
                updateBalances(tblTickers, rc, sio);
            });
        });




    ws.on('response', response => {
        console.log('response', response);
    })

    ws.on('update', data => {
        console.log(`update:${data.type}`, data);
        if(data.type === "subscribed") {
            console.warn('subscribed events not handled yet');
        } else if (data.type === "update") {
            if(data.channel === "trades") {
                largestTrade = extractLargestTrade(data.data)
                priceUpdate = {
                    ticker : data.market,
                    priceObj: largestTrade,
                    tradeVolume: largestTrade.price * largestTrade.size
                }
                sio.emit('price:update', priceUpdate);

                const uplevel = upalerts.get(priceUpdate.ticker);
                const downlevel = downalerts.get(priceUpdate.ticker);

                if(uplevel != null && priceUpdate.priceObj.price > uplevel){
                    sio.emit('alerts:triggered-up', priceUpdate);
                } else if(downlevel != null && priceUpdate.priceObj.price < downlevel){
                    sio.emit('alerts:triggered-down', priceUpdate);
                }

            } else if(data.channel === "fills") {
                console.warn('fills events not handled yet');

            }
        }
    })
}


function extractLargestTrade(trades) {
    return trades.sort((a, b) =>
            a.size - b.size
    ).slice(-1)[0]
}

const appPort = 5001
http.listen(appPort, () => {
  console.info(`Server is up and running on ${appPort} ...`);
  initFTXOps(socketio, ftxWS, ftxRestCli)
});

