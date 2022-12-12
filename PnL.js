

const {CoinUtils} = require("./AppUtils");

class PnL {

    static async buildCoinCostMap(tickersList, bookCostmap, ftxRestCli) {

        const balances = await ftxRestCli.getBalances();

        tickersList.map(async (ticker) => {

            const coin = CoinUtils.parseCoinFromBUSDTicker(ticker);

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

        const coin = CoinUtils.parseCoinFromTicker(ticker);

        if(coin === "USD"){
            return 0;
        }

        bookCostmap.delete(coin);

        var res = this.calculateCoinCost(coin, balances, orderHistory);
        bookCostmap.set(ticker, res);
    }


    static calculateCoinCost(coin, coinBalance, tradeHistory) {

        if(coinBalance === undefined){
            return 0;
        }

        if(Math.abs(coinBalance.free) < 0.00001){
            return 0;
        }

        console.log('calc coinssss');
        var balance = coinBalance.free;
        var reconstitutedBalanceHistory = [];

        // the tradeHistory is ordered in ascending order of time. So the oldest trades are first and most recent trades are last.
        // therefore we iterate the array in reverse order as we want to start from the most recent trades
        for (let i = tradeHistory.length - 1; i > -1; i--) {

            console.log('calc for', i);
            let t = tradeHistory[i];

            const dir = t.isBuyer ? 1 : -1;

            const tsize = t.qty;

            const avgFillPrice = t.price;

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


module.exports = PnL;