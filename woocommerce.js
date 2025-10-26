const axios = require('axios');

// Use environment variables if possible for security
const WP_API_USER = process.env.WP_API_USER || 'updateavenue_android';
const WP_API_PASS = process.env.WP_API_PASS || '123@UAAndroid';

// Create a single axios instance for all requests
const api = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  timeout: 10000,
  headers: {
    // Basic browser-like headers
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  auth: {
    username: WP_API_USER,
    password: WP_API_PASS
  }
});

// Optional: log every request for debugging
api.interceptors.request.use(config => {
  console.log(`[API Request] ${config.method.toUpperCase()} ${config.url}`);
  return config;
}, err => Promise.reject(err));

// Optional: log responses for debugging
api.interceptors.response.use(res => {
  console.log(`[API Response] ${res.status} ${res.config.url}`);
  return res;
}, err => {
  if (err.response) {
    console.error(`[API Error] ${err.response.status} ${err.response.config.url}`);
  } else {
    console.error(`[API Error] ${err.message}`);
  }
  return Promise.reject(err);
});

module.exports = api;
