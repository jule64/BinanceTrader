FROM node:18-alpine
WORKDIR /binance-trader
COPY package.json .
RUN npm install
COPY . .
RUN npm run tsc
EXPOSE 5001
CMD ["npm", "run", "dockerStart"]