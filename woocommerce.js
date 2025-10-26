const axios = require('axios');

const api = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  auth: {
    username: 'ck_81c43a53cd83b959d410bab94e22682b0d3196e2',
    password: 'cs_2fbb4501533607bb63c71442f77ab19f37f4cd0d'
  }
});

module.exports = api;
