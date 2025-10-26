const express = require('express');
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const app = express();
const PORT = process.env.PORT || 3000;
const cheerio = require('cheerio');
const axios = require('axios');
const FORCE_NGN_CURRENCY = '&currency=NGN';
require('dotenv').config();
const { Redis } = require('@upstash/redis');

//API
const consumerKeyWC = 'ck_bb500a1fb70b1094d43fd85296ad10c5dada160b';
const consumerSercretWC = 'cs_b7232701e74d5e22fe79c70b312e36acb4d8757a';

const api = new WooCommerceRestApi({
  url: 'https://updateavenues.com', 
  consumerKey: consumerKeyWC,
  consumerSecret: consumerSercretWC,
  version: 'wc/v3',
  queryStringAuth: true
});

const apiAxios = require('./woocommerce'); 

const apiAxio = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  auth: {
    username: 'ck_bb500a1fb70b1094d43fd85296ad10c5dada160b',
    password: 'cs_b7232701e74d5e22fe79c70b312e36acb4d8757a'
  }
});

// Redis setup
//const Redis = require('ioredis');

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// Redis connection events
// redis.on('connect', () => console.log('✅ Redis connected'));
// redis.on('error', (err) => console.error('❌ Redis error:', err));
// redis.on('ready', () => console.log('🚀 Redis ready'));
// redis.on('end', () => console.log('🔌 Redis disconnected'));


//Cache&Sync
const cron = require('node-cron');

let productSyncInProgress = false;
let categorySyncInProgress = false;

console.log(`${UPSTASH_REDIS_REST_URL}.  ||  ${UPSTASH_REDIS_REST_TOKEN}`);


const cache = {
  set: async (key, value, ttl = 3600) => {
    try {
      console.log(`💾 [cache-set] Setting key: ${key}, Type: ${typeof value}, Length: ${value?.length}`);

      if (value && value.length > 1000) {
        console.log(`📦 [cache] Large dataset detected (${value.length} items), splitting into chunks...`);

        const chunks = [];
        const chunkSize = 100;

        for (let i = 0; i < value.length; i += chunkSize) {
          chunks.push(value.slice(i, i + chunkSize));
        }

        for (let i = 0; i < chunks.length; i++) {
          await redis.setex(`${key}_chunk_${i}`, ttl, JSON.stringify(chunks[i]));
        }

        await redis.setex(`${key}_metadata`, ttl, JSON.stringify({
          totalChunks: chunks.length,
          totalItems: value.length,
          chunkSize: chunkSize,
          timestamp: Date.now()
        }));

        console.log(`✅ [cache] Stored ${chunks.length} chunks`);

        try {
          const existingKeys = await redis.keys(`${key}_chunk_*`);
          const keysToDelete = existingKeys.filter(k => {
            const match = k.match(/_chunk_(\d+)$/);
            return match && Number(match[1]) >= chunks.length;
          });
          if (keysToDelete.length > 0) {
            await redis.del(keysToDelete);
            console.log(`✅ Deleted old chunks: ${keysToDelete.join(', ')}`);
          }
        } catch (delErr) {
          console.error(`❌ Error deleting old chunks for "${key}":`, delErr.message);
        }

        return true;

      } else {
        const stringValue = JSON.stringify(value);
        console.log(`💾 [cache-set] Stringified length: ${stringValue.length} bytes`);
        await redis.setex(key, ttl, stringValue);
        return true;
      }

    } catch (err) {
      console.error(`❌ Redis set error for key ${key}:`, err.message);
      return false;
    }
  },

  get: async (key) => {
    try {
      console.log(`🔍 [cache-get] Getting key: ${key}`);

      const metadata = await redis.get(`${key}_metadata`);

      if (metadata) {
        console.log(`📦 [cache] Loading chunked data (${metadata.totalChunks} chunks)...`);
        const allChunks = [];

        for (let i = 0; i < metadata.totalChunks; i++) {
          const chunk = await redis.get(`${key}_chunk_${i}`);
          console.log(`   Chunk ${i}: Type: ${typeof chunk}, Length: ${chunk?.length}`);

          if (chunk) {
            const parsedChunk = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
            allChunks.push(...parsedChunk);
          }
        }

        console.log(`✅ [cache] Loaded ${allChunks.length} items`);
        return allChunks;
      } else {
        const data = await redis.get(key);
        console.log(`🔍 [cache-get] Raw data type: ${typeof data}, Has data: ${!!data}`);

        if (!data) {
          console.log(`🔍 [cache-get] No data found for key: ${key}`);
          return null;
        }

        if (typeof data === 'object') {
          console.log(`🔍 [cache-get] Returning parsed object directly, length: ${data.length}`);
          return data;
        }

        if (typeof data === 'string') {
          console.log(`🔍 [cache-get] Parsing string data, length: ${data.length}`);
          try {
            const parsed = JSON.parse(data);
            console.log(`🔍 [cache-get] Successfully parsed, type: ${typeof parsed}, length: ${parsed?.length}`);
            return parsed;
          } catch (parseErr) {
            console.error(`❌ JSON parse error for key ${key}:`, parseErr.message);
            console.error(`   Data sample: ${data.substring(0, 200)}`);
            return null;
          }
        }

        console.log(`❌ [cache-get] Unknown data type: ${typeof data}`);
        return null;
      }
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return null;
    }
  },

  getProducts: async (key, skip, limit) => {
    try {
      console.log(`🔍 [cache-get] Getting key: ${key}`);

      const metadataStr = await redis.get(`${key}_metadata`);
      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);
        const chunkInfo = getRequiredChunks(skip, limit);

        const chunkKeys = [];
        for (let i = chunkInfo.startChunk; i <= chunkInfo.endChunk; i++) {
          chunkKeys.push(`${key}_chunk_${i}`);
        }

        console.log(`📦 [cache] Loading ${chunkKeys.length} chunks in parallel...`);
        const chunks = await redis.get(chunkKeys);

        const allChunks = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk) {
            const parsed = (typeof chunk === 'string' && chunk[0] === '[')
              ? JSON.parse(chunk)
              : chunk;
            allChunks.push(...parsed);
          }
        }

        console.log(`✅ [cache] Loaded ${allChunks.length} items`);
        return allChunks;
      }

      const data = await redis.get(key);
      if (!data) return null;

      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return null;
    }
  },

  getPr: async (key, skip, limit) => {
    try {
      const metadata = await redis.get(`${key}_metadata`);
      if (!metadata) return [];

      const chunkInfo = getRequiredChunks(skip, limit);

      // 🚀 LOAD CHUNKS IN PARALLEL
      const chunkPromises = chunkInfo.chunksNeeded.map(chunkNum =>
        redis.get(`${key}_chunk_${chunkNum}`)
      );

      const chunks = await Promise.all(chunkPromises);

      let neededProducts = [];

      // 🎯 EXTRACT ONLY NEEDED ITEMS
      chunks.forEach((chunk, index) => {
        if (!chunk) return;

        const chunkNum = chunkInfo.chunksNeeded[index];
        const parsedChunk = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
        const chunkStartIndex = (chunkNum - 1) * metadata.chunkSize;

        const requestedStart = skip;
        const requestedEnd = skip + limit - 1;
        const overlapStart = Math.max(requestedStart, chunkStartIndex);
        const overlapEnd = Math.min(requestedEnd, chunkStartIndex + parsedChunk.length - 1);

        if (overlapStart <= overlapEnd) {
          const startInChunk = overlapStart - chunkStartIndex;
          const endInChunk = overlapEnd - chunkStartIndex;
          const slice = parsedChunk.slice(startInChunk, endInChunk + 1);
          neededProducts.push(...slice);
        }
      });

      return neededProducts.slice(0, limit);

    } catch (err) {
      console.error(`❌ Redis getP error:`, err.message);
      return [];
    }
  },

  getPOld: async (key, skip, limit) => {
    try {
      console.log(`🔍 [cache-get] Getting key: ${key}`);

      const metadata = await redis.get(`${key}_metadata`);

      if (metadata) {
        const parsedMetadata = (metadata);
        console.log(`📦 [cache] Loading chunked data (${parsedMetadata.totalChunks}, ${parsedMetadata.totalItems}, ${parsedMetadata.chunkSize} chunks)...`);

        const allChunks = [];
        const total = skip + limit;
        const chunkNumber = getChunkNumber(skip);
        const isMoreNeeded = isCrossingChunkBoundary(skip, limit);
        const place = total;
        const chunkInfo = getRequiredChunks(skip, limit);

        console.log(`chunkNumber : ${chunkNumber}`);
        console.log(`isMoreNeeded : ${isMoreNeeded}`);
        console.log(`place : ${place}`);
        console.log(`chunkInfo : ${JSON.stringify(chunkInfo)}`);

        const chunksNeeded = chunkInfo.chunksNeeded;
        const totalChunks = chunkInfo.totalChunksNeeded;
        const startChunk = chunkInfo.startChunk;
        const endChunk = chunkInfo.endChunk;

        for (let i = startChunk; i <= endChunk; i++) {
          const chunk = await redis.get(`${key}_chunk_${i}`);
          console.log(`   Chunk ${i}: Type: ${typeof chunk}, Length: ${chunk?.length}`);

          if (chunk) {
            const parsedChunk = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
            allChunks.push(...parsedChunk);
            console.log(`✅ [cache] adding chunk ${parsedChunk.length} items`);
          }
        }

        console.log(`✅ [cache] Loaded ${allChunks.length} items`);
        return allChunks;
      } else {
        const data = await redis.get(key);
        console.log(`🔍 [cache-get] Raw data type: ${typeof data}, Has data: ${!!data}`);

        if (!data) {
          console.log(`🔍 [cache-get] No data found for key: ${key}`);
          return null;
        }

        if (typeof data === 'object') {
          console.log(`🔍 [cache-get] Returning parsed object directly, length: ${data.length}`);
          return data;
        }

        if (typeof data === 'string') {
          console.log(`🔍 [cache-get] Parsing string data, length: ${data.length}`);
          try {
            const parsed = JSON.parse(data);
            console.log(`🔍 [cache-get] Successfully parsed, type: ${typeof parsed}, length: ${parsed?.length}`);
            return parsed;
          } catch (parseErr) {
            console.error(`❌ JSON parse error for key ${key}:`, parseErr.message);
            console.error(`   Data sample: ${data.substring(0, 200)}`);
            return null;
          }
        }

        console.log(`❌ [cache-get] Unknown data type: ${typeof data}`);
        return null;
      }
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return null;
    }
  },

  getP: async (key, skip, limit) => {
    try {
      console.log(`🔍 [cache-get] Getting key: ${key}`);

      const metadataStr = await redis.get(`${key}_metadata`);

      if (metadataStr) {
        const metadata = (metadataStr);
        console.log(`📦 [cache] Loading chunked data (${metadata.totalChunks} chunks, ${metadata.totalItems} total items, chunkSize: ${metadata.chunkSize})`);

        const chunkInfo = getRequiredChunks(skip, limit);
        const startChunk = chunkInfo.startChunk;
        const endChunk = chunkInfo.endChunk;

        let allItems = [];

        // Load only required chunks
        for (let i = startChunk; i <= endChunk; i++) {
          const chunk = await redis.get(`${key}_chunk_${i}`);
          if (chunk) {
            const parsedChunk = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
            allItems.push(...parsedChunk);
          }
        }

        // Slice the exact range requested
        const offset = (skip - (startChunk * metadata.chunkSize));
        const requestedProducts = allItems.slice(offset, offset + limit);

        const hasMoreProducts = skip + requestedProducts.length < metadata.totalItems;

        console.log(`chunkInfor : ${JSON.stringify(chunkInfo)}`)
        console.log(`✅ [cache] Returning ${requestedProducts.length} products, hasMoreProducts: ${hasMoreProducts}`);

        console.log(`✅ [startIndexInChunk] Returning ${offset} products, requestedProducts: ${requestedProducts} && allItems ${allItems}`);
        console.log(`✅ [cache] Returning ${requestedProducts.length} products, hasMoreProducts: ${hasMoreProducts}`);

        return {
          products: requestedProducts,
          hasMoreProducts,
          totalProducts: metadata.totalItems
        };
      } else {
        const data = await redis.get(key);
        if (!data) return { products: [], hasMoreProducts: false, totalProducts: 0 };

        const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
        const requestedProducts = parsedData.slice(skip, skip + limit);
        const hasMoreProducts = skip + requestedProducts.length < parsedData.length;

        return {
          products: requestedProducts,
          hasMoreProducts,
          totalProducts: parsedData.length
        };
      }
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return { products: [], hasMoreProducts: false, totalProducts: 0 };
    }
  },

  getCategoryProducts: async (key, skip, limit) => {
    try {
      console.log(`🔍 [cache-get] Getting key: ${key}`);

      const metadataStr = await redis.get(`${key}_metadata`);

      if (metadataStr) {
        const metadata = (metadataStr);
        console.log(`📦 [cache] Loading chunked data (${metadata.totalChunks} chunks, ${metadata.totalItems} total items, chunkSize: ${metadata.chunkSize})`);

        const chunkInfo = getRequiredChunks(skip, limit);
        const startChunk = chunkInfo.startChunk;
        const endChunk = chunkInfo.endChunk;

        let allItems = [];

        // Load only required chunks
        for (let i = startChunk; i <= endChunk; i++) {
          const chunk = await redis.get(`${key}_chunk_${i}`);
          if (chunk) {
            const parsedChunk = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
            allItems.push(...parsedChunk);
          }
        }

        // Slice the exact range requested
        const offset = (skip - (startChunk * metadata.chunkSize));
        const requestedProducts = allItems.slice(offset, offset + limit);

        const hasMoreProducts = skip + requestedProducts.length < metadata.totalItems;

        console.log(`chunkInfor : ${JSON.stringify(chunkInfo)}`)
        console.log(`✅ [cache] Returning ${requestedProducts.length} products, hasMoreProducts: ${hasMoreProducts}`);

        console.log(`✅ [startIndexInChunk] Returning ${offset} products, requestedProducts: ${requestedProducts} && allItems ${allItems}`);
        console.log(`✅ [cache] Returning ${requestedProducts.length} products, hasMoreProducts: ${hasMoreProducts}`);

        return {
          products: requestedProducts,
          hasMoreProducts,
          totalProducts: metadata.totalItems
        };
      } else {
        const data = await redis.get(key);
        if (!data) return { products: [], hasMoreProducts: false, totalProducts: 0 };

        const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
        const requestedProducts = parsedData.slice(skip, skip + limit);
        const hasMoreProducts = skip + requestedProducts.length < parsedData.length;

        return {
          products: requestedProducts,
          hasMoreProducts,
          totalProducts: parsedData.length
        };
      }
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return { products: [], hasMoreProducts: false, totalProducts: 0 };
    }
  },

  del: async (key) => {
    try {
      console.log(`🗑️ [cache-del] Deleting key: ${key}`);
      await redis.del(key);
      await redis.del(`${key}_metadata`);
      return true;
    } catch (err) {
      console.error(`❌ Redis delete error for key ${key}:`, err.message);
      return false;
    }
  }
};

async function syncWooData(caller = 'unknown') {
  if (productSyncInProgress) {
    console.log(`⏳ [syncWooData] Already in progress, called from ${caller}, skipping...`);
    return;
  }

  productSyncInProgress = true;
  let allProducts = [];
  let successCount = 0;
  let failCount = 0;
  
  try {
    console.log(`🌀 [syncWooData] Called from: ${caller} — Starting WooCommerce products sync...`);
    
    console.log(`📊 [syncWooData] Fetching total product count...`);
    const countRes = await api.get('products', { per_page: 100, min_price: 1, timeout: 30000 });
    const totalProducts = parseInt(countRes.headers['x-wp-total'] || 0);
    const totalPages = parseInt(countRes.headers['x-wp-totalpages'] || 1);
    
    console.log(`📈 [syncWooData] Total Products: ${totalProducts}, Total Pages: ${totalPages}`);
    console.log(`🔄 [syncWooData] Starting to fetch ${totalPages} pages...`);

    for (let page = 1; page <= totalPages; page++) {
      let retries = 3;
      let pageSuccess = false;
      
      console.log(`📄 [syncWooData] Processing page ${page}/${totalPages}...`);
      
      while (retries > 0 && !pageSuccess) {
        try {
          console.log(`   🔄 [syncWooData] Page ${page} - Attempt ${4 - retries}/3`);
          const response = await api.get('products', { per_page: 100, page, timeout: 30000 });
          allProducts = allProducts.concat(response.data);
          
          console.log(`   ✅ [syncWooData] Page ${page} SUCCESS - Got ${response.data.length} products`);
          successCount++;
          pageSuccess = true;
          
          const progress = ((page / totalPages) * 100).toFixed(1);
          console.log(`   📊 [syncWooData] Progress: ${progress}% (${page}/${totalPages} pages completed)`);
          
          break;
          
        } catch (err) {
          retries--;
          console.warn(`   ❌ [syncWooData] Page ${page} - Attempt ${4 - retries}/3 FAILED: ${err.message}`);
          
          if (retries === 0) {
            console.error(`   💥 [syncWooData] Page ${page} - ALL RETRIES FAILED, skipping this page`);
            failCount++;
          } else {
            console.log(`   ⏳ [syncWooData] Retrying page ${page} in 2 seconds...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      
      if (page < totalPages) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`🎯 [syncWooData] SYNC COMPLETED!`);
    console.log(`   📈 Successfully processed: ${successCount}/${totalPages} pages`);
    console.log(`   📉 Failed pages: ${failCount}/${totalPages} pages`);
    console.log(`   📦 Total products fetched: ${allProducts.length}`);
    
    const validProducts = allProducts.filter(p => p.stock_status === 'instock' && parseFloat(p.price || 0) > 0);
    
    console.log(`   ✅ Valid products (in stock & priced): ${validProducts.length}`);
    console.log(`   🗑️  Invalid products filtered out: ${allProducts.length - validProducts.length}`);

    if (validProducts.length > 0) {
      const cacheSuccess = await cache.set('allProducts', validProducts);
      if (cacheSuccess) {
        console.log(`💾 [syncWooData] SUCCESS - Cached ${validProducts.length} valid products in Redis`);
      } else {
        console.error(`❌ [syncWooData] FAILED - Could not cache products in Redis`);
      }
    } else {
      console.warn(`⚠️ [syncWooData] WARNING - No valid products fetched, keeping old cache`);
    }
    
    console.log(`📋 [syncWooData] FINAL STATISTICS:`);
    console.log(`   • Total Pages: ${totalPages}`);
    console.log(`   • Successful Pages: ${successCount}`);
    console.log(`   • Failed Pages: ${failCount}`);
    console.log(`   • Success Rate: ${((successCount / totalPages) * 100).toFixed(1)}%`);
    console.log(`   • Total Products Fetched: ${allProducts.length}`);
    console.log(`   • Valid Products: ${validProducts.length}`);
    console.log(`   • Cache Status: ${validProducts.length > 0 ? 'UPDATED' : 'UNCHANGED'}`);

  } catch (err) {
    console.error(`💥 [syncWooData] CRITICAL ERROR (called from ${caller}): ${err.message}`);
    console.error(`   Stack: ${err.stack}`);
  } finally {
    productSyncInProgress = false;
    console.log(`🏁 [syncWooData] Sync process finished. Lock released.`);
  }
}

async function syncWooCategories(caller = 'unknown') {
  if (categorySyncInProgress) {
    console.log(`⏳ [syncWooCategories] Already in progress, called from ${caller}, skipping...`);
    return;
  }

  categorySyncInProgress = true;
  try {
    console.log(`🌀 [syncWooCategories] Called from: ${caller} — Syncing WooCommerce categories...`);
    
    const categoryRes = await apiAxios.get('products/categories', { params: { per_page: 100 }, timeout: 10000 });
    const categories = categoryRes.data;
    const categoryMap = {};

    const PQueue = (await import('p-queue')).default;
    const queue = new PQueue({ concurrency: 10 });
    
    await Promise.all(categories.map(cat => queue.add(async () => {
      try {
        const productRes = await apiAxios.get('products', {
          params: { per_page: 1, category: cat.id, stock_status: 'instock' },
          timeout: 10000
        });
        const product = productRes.data[0];
        if (product?.images?.[0]?.src) {
          categoryMap[cat.id] = { 
            id: cat.id, 
            name: cat.name, 
            image: product.images[0].src 
          };
        }
      } catch (err) {
        console.log(`⚠️ Failed to get image for category ${cat.name}`);
      }
    })));

    await queue.onIdle();
    const categoriesArray = Object.values(categoryMap);
    
    console.log(`✅ [syncWooCategories] Processed ${categoriesArray.length} categories with images`);
    
    if (categoriesArray.length > 0) {
      const cacheSuccess = await cache.set('allCategories', categoriesArray);
      if (cacheSuccess) {
        console.log(`💾 [syncWooCategories] Cached ${categoriesArray.length} categories`);
      } else {
        console.error(`❌ [syncWooCategories] Failed to cache categories`);
      }
    }

  } catch (err) {
    console.error(`❌ [syncWooCategories] Failed: ${err.message}`);
  } finally {
    categorySyncInProgress = false;
  }
}

async function syncCategoryProducts(categoryId) {
  try {
    const allProducts = [];
    let page = 1;

    while (true) {
      const response = await apiAxios.get('products', {
        params: {
          per_page: 100,
          page: page,
          category: categoryId,
          min_price: 1
        },
        timeout: 10000
      });

      if (!response.data || response.data.length === 0) break;

      allProducts.push(...response.data);
      if (response.data.length < 100) break;
      page++;
    }

    const cachedCategoryProducts = allProducts.filter(p => p.price && p.stock_status === 'instock');
    console.error(`Category Products Synced ${categoryId}  : ${cachedCategoryProducts.length},  ${cachedCategoryProducts.result} products:`);
    const isSuccess = await cache.set(`category_${categoryId}`, cachedCategoryProducts, 1800);
    if (isSuccess) {
      console.log(`✅ [syncWooCategories] Redis cached ${cachedCategoryProducts.length} categories`);
    } else {
      console.error(`❌ [syncWooCategories] Failed to cache categories in Redis`);
    }
    return cachedCategoryProducts;
  } catch (error) {
    console.error(`❌ Error syncing category ${categoryId} products:`, error.message);
    throw error;
  }
}

cron.schedule('*/60 * * * *', () => {
  console.log('🕒 Scheduled 15-min sync triggered...');
  syncWooData('cron schedule');
  syncWooCategories('cron schedule');
});

async function initializeApp() {
  try {
    //await redis.connect();
    console.log('🔄 Initial data sync starting...');
    await syncWooData('app startup');
    await syncWooCategories('app startup');
    console.log('✅ App initialization complete');
  } catch (err) {
    console.error('❌ App initialization failed:', err.message);
  }
}

const getChunkNumber = (skip, chunkSize = 100) => {
  return Math.floor(Number(skip) / chunkSize);
};

const isCrossingChunkBoundary = (skip, limit, chunkSize = 100) => {
  const currentChunkStart = Math.floor(skip / chunkSize) * chunkSize;
  const positionInChunk = skip - currentChunkStart;
  return (positionInChunk + limit) > chunkSize;
};

const getRequiredChunks = (skip, limit, chunkSize = 100) => {
  const startChunk = getChunkNumber(skip, chunkSize);
  const endIndex = skip + limit - 1;
  const endChunk = getChunkNumber(endIndex, chunkSize);
  
  const chunksNeeded = Array.from({ length: endChunk - startChunk + 1 }, (_, i) => startChunk + i);
  
  return {
    startChunk,
    endChunk,
    chunksNeeded,
    totalChunksNeeded: chunksNeeded.length,
    crossesBoundary: endChunk > startChunk
  };
};

async function deleteOldChunks(key) {
  try {
    // Get all keys matching the pattern
    const keys = await redis.keys(`${key}_*`);
    if (keys.length === 0) {
      console.log(`No old chunks found for key: ${key}`);
      return;
    }

    // Delete all at once
    await redis.del(keys);
    console.log(`✅ Deleted all old chunks and metadata for "${key}": ${keys.join(', ')}`);
  } catch (err) {
    console.error(`❌ Error deleting old chunks for "${key}":`, err.message);
  }
}

// Example: skip=490, limit=20 → {startChunk:1, endChunk:2, chunksNeeded:[1,2], crossesBoundary:true}

//initializeApp();


app.get('/',async(req,res)=>{
try {
    // productSyncInProgress = false;
    // categorySyncInProgress = false;
    // await syncWooData();
    // await syncWooCategories();
    res.json({ success: true, message: 'API refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/clear-cache', async (req, res) => {
  try {
    await cache.del('allCategories');
    await deleteOldChunks('allProducts');
    await cache.del('category_26');
    await cache.del('category_27');
    await cache.del('category_26');
    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/refreshCache', async (req, res) => {
  try {
    productSyncInProgress = false;
    await syncWooData('/refreshCache route');
    res.json({ success: true, message: 'Cache refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/refreshCacheCategory', async (req, res) => {
  try {
    categorySyncInProgress = false;
    await syncWooCategories('/refreshCache route');
    res.json({ success: true, message: 'Cache refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/getallProducts', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;

    const cachedProducts = await cache.getP('allProducts',skip,limit);
    if (cachedProducts && cachedProducts.products.length > 0) {
      //const products = cachedProducts.slice(skip, skip + limit);
      const products = cachedProducts.products;
      const hasMore = cachedProducts.hasMoreProducts;
      const totalP = cachedProducts.totalProducts;
      console.log(`Fetched from synced cache.`);
      res.status(200).json({
        success: true,
        source: 'cache',
        skip,
        nextSkip: skip + products.length,
        hasMore: hasMore,
        totalProducts: totalP,
        products
      });
      return;
    }

    const page = Math.floor(skip / limit) + 1;
    const response = await api.get('products', { per_page: limit, page, min_price: 1 });
    const rawProducts = response.data.filter(p => p.price);
    console.log(`Fetched from api.`);
    res.status(200).json({
      success: true,
      source: 'api',
      skip,
      nextSkip: skip + rawProducts.length,
      hasMore: rawProducts.length === limit,
      totalProducts: rawProducts.length,
      products: rawProducts
    });

    //syncWooData('getallProducts route');
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getallProductsOld', async (req, res) => {
  try {
   const skip = parseInt(req.query.skip) || 0;
    const limit = 20;

    const page = Math.floor(skip / limit) + 1;
    const offsetWithinPage = skip % limit;

    const response = await api.get('products', {
      per_page: limit,
      page: page,
      min_price: 1
    });

    const rawProducts = response.data;

    const filteredProducts = rawProducts.filter(p => {
      return p.price !== null && p.price !== '' && p.price !== undefined;
    });

    const products = rawProducts.slice(offsetWithinPage, offsetWithinPage + limit);
    const productsFilter = filteredProducts.slice(offsetWithinPage, offsetWithinPage + limit);

    res.status(200).json({
      success: true,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit,
      totalProducts: products.length,
      products: products,
      productsFilter : productsFilter
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProduct', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const key = `category_${String(category).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    let cachedCategoryProducts = await cache.get(key);
    let source = 'cache';

    //console.log('cachedCategoryProducts :', cachedCategoryProducts,  cachedCategoryProducts.length);

    if (cachedCategoryProducts && Array.isArray(cachedCategoryProducts)) {
      cachedCategoryProducts = cachedCategoryProducts;
      const products = cachedCategoryProducts.slice(skip, skip + limit);
      res.status(200).json({
        success: true,
        source,
        category,
        skip,
        nextSkip: skip + products.length,
        hasMore: skip + products.length < cachedCategoryProducts.length,
        totalProducts: cachedCategoryProducts.length,
        products
      });
    } else {
      //cachedCategoryProducts = await syncCategoryProducts(category);
      source = 'api';
      const page = Math.floor(skip / limit) + 1;

      console.log("Fetching products for category:", category, "Page:", page);

      const response = await apiAxio.get('products', {
        params: {
          per_page: limit,
          page: page,
          category: category,
          min_price: 1
        },
        auth: {
          username: consumerKeyWC,
          password: consumerSercretWC
        },
        timeout: 10000
      });

      const products = response.data;
      res.status(200).json({
        success: true,
        category: category,
        skip: skip,
        nextSkip: skip + products.length,
        hasMore: products.length === limit,
        totalProducts: products.length,
        products: products
      });
    }

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProductOld', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const page = Math.floor(skip / limit) + 1;

    console.log("Fetching products for category:", category, "Page:", page);

    const response = await apiAxios.get('products', {
      params: {
        per_page: limit,
        page: page,
        category: category,
        min_price: 1
      },
      timeout: 10000
    });

    const products = response.data;

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit,
      totalProducts: products.length,
      products: products
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

//WithFilterSort
app.get('/getCategoriesProductWithSortFilterOld', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;
    const orderby = req.query.orderby || 'menu_order';
    const order = req.query.order || 'asc';
    const min_price = req.query.min_price;
    const max_price = req.query.max_price;
    const on_sale = req.query.on_sale;
    const stock_status = req.query.stock_status;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const page = Math.floor(skip / limit) + 1;

    console.log("Fetching products with filters:", {
      category,
      page,
      orderby,
      order,
      min_price,
      max_price,
      on_sale,
      stock_status
    });

    const wooCommerceParams = {
      per_page: limit,
      page: page,
      category: category,
      orderby: orderby,
      order: order
    };

    if (min_price) wooCommerceParams.min_price = min_price;
    if (max_price) wooCommerceParams.max_price = max_price;
    if (on_sale === 'true') wooCommerceParams.on_sale = true;
    if (stock_status) wooCommerceParams.stock_status = stock_status;

    const response = await apiAxios.get('products', {
      params: wooCommerceParams,
      timeout: 10000
    });

    let products = response.data;

    products = products.filter(product => {
      const price = product.price;
      return price && typeof price === 'string' && price.trim() !== '' && price !== '0';
    });

    if (min_price || max_price) {
      products = products.filter(product => {
        const price = parseFloat(product.price);
        return !isNaN(price) && 
               (!min_price || price >= parseFloat(min_price)) && 
               (!max_price || price <= parseFloat(max_price));
      });
    }

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit, 
      totalProducts: products.length,
      products: products,
      appliedFilters: {
        orderby,
        order,
        min_price,
        max_price,
        on_sale,
        stock_status
      }
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProductWithSortFilter', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;
    const orderby = req.query.orderby || 'menu_order';
    const order = req.query.order || 'asc';
    const min_price = req.query.min_price;
    const max_price = req.query.max_price;
    const on_sale = req.query.on_sale;
    const stock_status = req.query.stock_status;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    console.log("Fetching products with filters:", {
      category,
      skip,
      orderby,
      order,
      min_price,
      max_price,
      on_sale,
      stock_status
    });

    // NEW: Fetch ALL products first, then paginate
    let allProducts = [];
    let currentPage = 1;
    const maxPages = 10; // Safety limit to prevent infinite loops

    while (currentPage <= maxPages) {
      const wooCommerceParams = {
        per_page: 100,
        page: currentPage,
        category: category,
        orderby: orderby,
        order: order
      };

      if (min_price) wooCommerceParams.min_price = min_price;
      if (max_price) wooCommerceParams.max_price = max_price;
      if (on_sale === 'true') wooCommerceParams.on_sale = true;
      if (stock_status) wooCommerceParams.stock_status = stock_status;

      const response = await apiAxios.get('products', {
        params: wooCommerceParams,
        timeout: 10000
      });

      let products = response.data;

      // Filter out invalid products
      products = products.filter(product => {
        const price = product.price;
        return price && typeof price === 'string' && price.trim() !== '' && price !== '0';
      });

      // Apply price range filtering
      if (min_price || max_price) {
        products = products.filter(product => {
          const price = parseFloat(product.price);
          return !isNaN(price) && 
                 (!min_price || price >= parseFloat(min_price)) && 
                 (!max_price || price <= parseFloat(max_price));
        });
      }

      // If no products returned, break the loop
      if (products.length === 0) {
        break;
      }

      allProducts = allProducts.concat(products);
      
      // If we got less than 100 products, we've reached the end
      if (products.length < 100) {
        break;
      }

      currentPage++;
    }

    // Apply manual sorting if needed
    if (orderby === 'price') {
      allProducts.sort((a, b) => {
        const priceA = parseFloat(a.price);
        const priceB = parseFloat(b.price);
        
        if (order === 'desc') {
          return priceB - priceA; 
        } else {
          return priceA - priceB; 
        }
      });
    }

    // Now apply pagination to the fully sorted list
    const startIndex = skip;
    const endIndex = Math.min(startIndex + limit, allProducts.length);
    const paginatedProducts = allProducts.slice(startIndex, endIndex);

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: endIndex,
      hasMore: endIndex < allProducts.length,
      totalProducts: allProducts.length,
      products: paginatedProducts,
      appliedFilters: {
        orderby,
        order,
        min_price,
        max_price,
        on_sale,
        stock_status
      }
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

//HomeCategories
app.get('/getAllCategoriesWithOneProductImage', async (req, res) => {
  try {
    let categories = await cache.get('allCategories');

    if (categories && categories.length > 0) {
      console.log('Fetched from cache');
      res.status(200).json({ success: true, source: 'cache', totalCategories: categories.length, categories });
      //syncWooCategories('getAllCategoriesRoute route');
      return;
    }

    console.log('⚠️ Category cache empty — fetching directly for fast response...');
    const categoryRes = await apiAxio.get('products/categories', { params: { per_page: 100 }, timeout: 10000 });
    const allCategories = categoryRes.data;

    const categoriesWithImage = await Promise.all(
      allCategories.map(async (cat) => {
        try {
          const productRes = await apiAxios.get('products', {
            params: { per_page: 1, category: cat.id, stock_status: 'instock' },
            timeout: 10000
          });
          const product = productRes.data[0];
          if (product && product.images?.length > 0 && product.images[0].src) {
            return { id: cat.id, name: cat.name, image: product.images[0].src };
          }
          return null;
        } catch {
          return null;
        }
      })
    );

    categories = categoriesWithImage.filter(Boolean);
    res.status(200).json({ success: true, source: 'api', totalCategories: categories.length, categories });

    syncWooCategories('getAllCategoriesRoute route');
  } catch (err) {
    console.error("Error fetching categories:", err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch categories', error: err.message });
  }
});

app.get('/getAllCategoriesWithOneProductImageOld', async (req, res) => {
  try {
    const categoryRes = await apiAxios.get('products/categories', {
      params: {
        per_page: 100
      },
      timeout: 10000
    });

    const categories = categoryRes.data;

    const filteredCategories = await Promise.all(categories.map(async (cat) => {
      try {
        const productRes = await apiAxios.get('products', {
          params: {
            per_page: 1,
            category: cat.id,
            stock_status: 'instock',
          },
          timeout: 10000
        });

        const product = productRes.data[0];

        if (product && product.images && product.images.length > 0 && product.images[0].src) {
          return {
            id: cat.id,
            name: cat.name,
            image: product.images[0].src
          };
        }

        return null;
      } catch (err) {
        return null;
      }
    }));

    const validCategories = filteredCategories.filter(item => item !== null);

    res.status(200).json({
      success: true,
      totalCategories: validCategories.length,
      categories: validCategories
    });

  } catch (error) {
    console.error("Error fetching categories:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch filtered categories',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getHomePageBanners', async (req, res) => {
  try {
    const banners = [
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/m.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      },
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/pjg-1.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      },
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/HH-1.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      }
    ];

    res.json({
      success: true,
      total: banners.length,
      banners
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

//SpecificProducts
app.get('/getSpecificProducts', async (req, res) => {
  try {
    const productIds = req.query.ids;
    
    if (!productIds) {
      return res.status(400).json({
        success: false,
        message: 'Product IDs are required. Use ?ids=id1,id2,id3 format'
      });
    }

    const idsArray = productIds.split(',').map(id => id.trim()).filter(id => id !== '');
    
    if (idsArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid product IDs provided'
      });
    }

    const batchSize = 20; 
    const allProducts = [];

    for (let i = 0; i < idsArray.length; i += batchSize) {
      const batchIds = idsArray.slice(i, i + batchSize);
      
      const response = await api.get('products', {
        include: batchIds.join(','),
        per_page: batchSize
      });

      if (response.data && Array.isArray(response.data)) {
        allProducts.push(...response.data);
      }
      
      if (i + batchSize < idsArray.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const validProducts = allProducts.filter(p => {
      return p && p.price !== null && p.price !== '' && p.price !== undefined;
    });

    res.status(200).json({
      success: true,
      totalRequested: idsArray.length,
      totalFound: validProducts.length,
      products: validProducts,
      missingProducts: idsArray.length - validProducts.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch specific products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getOnlyOneProduct', async (req, res) => {
  try {
    const productId = req.query.id;
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required. Use ?id=product_id format'
      });
    }

    if (isNaN(Number(productId))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format. Must be a numeric value'
      });
    }

    const response = await api.get(`products/${productId}`);
    
    if (!response.data || response.data.price === null || response.data.price === '' || response.data.price === undefined) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or has invalid price data',
        productId: productId
      });
    }

    res.status(200).json({
      success: true,
      product: response.data
    });

  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
        productId: req.query.id,
        error: 'Product does not exist'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      productId: req.query.id,
      error: error.response?.data || error.message
    });
  }
});

app.listen(PORT,'192.168.29.145', () => {
  console.log(`Server running on http://192.168.29.145:${PORT}`);
});