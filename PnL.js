

const {CoinUtils} = require("./AppUtils");

class PnL {

    static async buildCoinCostMap(tickersList, bookCostmap, ftxRestCli) {

        const balances = await ftxRestCli.getBalances();

        tickersList.map(async (ticker) => {

            const coin = CoinUtils.parseCoinFromTicker(ticker);

            if(coin === "USD"){
                return 0;
            }

            if (bookCostmap.get(coin) == null) {
                const orderHistory = await ftxRestCli.getOrderHistory({market: ticker});

                var res = this.calculateCoinCost(coin, balances.result, orderHistory.result);
                bookCostmap.set(ticker, res);
            }
        })

        return bookCostmap

    }

    static buildCoinBookCost(ticker, bookCostmap, balances, orderHistory) {

        if(coin === "USD"){
            return 0;
        }

        bookCostmap.delete(coin);

        var res = this.calculateCoinCost(coin, balances.result, orderHistory.result);
        bookCostmap.set(ticker, res);
    }


    static calculateCoinCost(coin, balances, orderHistory) {

        const coinBalance = balances.filter(v => v.coin === coin)[0];

        if(coinBalance === undefined){
            return 0;
        }
        if(Math.abs(coinBalance.usdValue) < 10){
            return 0;
        }

        var balance = coinBalance.total;
        var reconstitutedBalanceHistory = [];
        for (const t of orderHistory) {

            const dir = t.side === "buy" ? 1 : -1;

            const tsize = t.filledSize;



            if(tsize === 0){
                // we move to next order since this order did not fill
                continue;
            }

            const avgFillPrice = t.avgFillPrice;

            if (tsize <= Math.abs(balance) + 0.000001) {
                reconstitutedBalanceHistory.push({tradeSize: tsize, cost: dir * tsize * avgFillPrice});
                balance = balance - (dir * tsize);
            } else {
                reconstitutedBalanceHistory.push({
                    tradeSize: balance,
                    cost: balance * avgFillPrice
                })
                balance = 0;
            }

            // exit the book cost calculation if remaining balance is less than 10 USD (the USD value
            // of the remaining balance is calculated using the filled price of the last processed order)
            if (Math.abs(balance) * avgFillPrice < 10) {
                break;
            }
        }

        const totalCostOfCoins = reconstitutedBalanceHistory.reduce((r, v) => r + v.cost, 0);

        return Math.abs(totalCostOfCoins) < 1 ? 0 : totalCostOfCoins;


    }




}

async function coinBookCostTest(coin) {

    const apikeys = require('./apikeys/apikeys.json');

    const {RestClient} = require("ftx-api");
    const ftxRestCli = new RestClient(apikeys.key, apikeys.secret);

    const balances = await ftxRestCli.getBalances();
    const orderHistory = await ftxRestCli.getOrderHistory({market: coin + "/USD"});


    return calculateCoinCost(coin, balances.result, orderHistory.result);

}


module.exports = PnL;