const axios = require('axios');

const api = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  auth: {
    username: 'ck_bb500a1fb70b1094d43fd85296ad10c5dada160b',
    password: 'cs_b7232701e74d5e22fe79c70b312e36acb4d8757a'
  }
});

module.exports = api;
