#!/usr/bin/env node
const axios = require('axios');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const { format } = require('date-fns');
const cliProgress = require('cli-progress');
const mime = require('mime-types');
const os = require('os');

const USERNAME = 'manikrathee';
const AUTH_USER = 'manikrathee@gmail.com';
const AUTH_PASS = 'save and organize 18 72 63 ok';
const BASE_URL = `https://${USERNAME}.dropmark.com`;

const authHeader = {
  Authorization: `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')}`
};

async function fetchActivity() {
  try {
    const response = await axios.get(`${BASE_URL}/activity.json`, {
      headers: authHeader
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching activity feed:', error.message);
    return [];
  }
}

async function getCollectionsFromActivity() {
  console.log('Fetching activity feed to discover collections...');
  const activity = await fetchActivity();
  const collections = new Map();

  activity.forEach(item => {
    if (item.collection_id && item.collection_name) {
      collections.set(item.collection_id, {
        id: item.collection_id,
        name: item.collection_name,
        url: item.collection_url
      });
    }
  });

  return Array.from(collections.values());
}

async function fetchCollectionItems(collectionId) {
  try {
    const response = await axios.get(`${BASE_URL}/${collectionId}.json`, {
      headers: authHeader
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching collection ${collectionId}:`, error.message);
    return null;
  }
}

async function downloadFile(url, dest) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(dest);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    // console.error(`Failed to download ${url}:`, error.message);
    throw error;
  }
}

async function processCollection(collection, baseDir) {
  const collectionDir = path.join(baseDir, collection.name.replace(/[/\\?%*:|"<>]/g, '-')); // Sanitize name
  await fs.ensureDir(collectionDir);

  console.log(`\nProcessing collection: ${collection.name}`);

  const data = await fetchCollectionItems(collection.id);
  if (!data) return;

  // Save index
  await fs.writeJson(path.join(collectionDir, 'index.json'), data, { spaces: 2 });

  const items = data.items || [];
  console.log(`Found ${items.length} items.`);

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(items.length, 0);

  for (const item of items) {
    if (item.type === 'image' || item.type === 'file' || item.type === 'video' || item.type === 'audio') {
      const fileUrl = item.content || item.url; // content usually has the file url
      if (fileUrl) {
        // Determine filename
        let filename = item.name || 'untitled';

        // Determine extension
        let extension = item.extension;

        // 1. Try to get extension from URL
        if (!extension && fileUrl) {
          try {
            const urlExt = path.extname(new URL(fileUrl).pathname);
            if (urlExt) {
              extension = urlExt.replace('.', '');
            }
          } catch (e) {
            // URL might be malformed, ignore
          }
        }

        // 2. Try to get extension from MIME type
        if (!extension && item.mime) {
          extension = mime.extension(item.mime);
        }

        // 3. Fallback for common types if mime lookup fails or gives generic result
        if (!extension) {
          if (item.type === 'image') extension = 'jpg';
          else if (item.type === 'audio') extension = 'mp3';
          else if (item.type === 'video') extension = 'mp4';
        }

        // Sanitize filename
        filename = filename.replace(/[/\\?%*:|"<>]/g, '-');

        // Append extension if not already present
        if (extension) {
          const extWithDot = `.${extension}`;
          if (!filename.toLowerCase().endsWith(extWithDot.toLowerCase())) {
            filename += extWithDot;
          }
        }

        // If filename is still weird (just extension or empty), use id
        if (!filename || filename === 'untitled' || filename.startsWith('.')) {
          filename = `${item.id}${extension ? '.' + extension : ''}`;
        }

        try {
          await downloadFile(fileUrl, path.join(collectionDir, filename));
        } catch (e) {
          // console.error(`Failed to download ${filename}`);
        }
      }
    } else if (item.type === 'link') {
      if (item.link) {
        const linkContent = `[InternetShortcut]\nURL=${item.link}`;
        let linkName = item.name || 'link';
        linkName = linkName.replace(/[/\\?%*:|"<>]/g, '-');
        await fs.writeFile(path.join(collectionDir, `${linkName}.url`), linkContent);
      }
    }
    bar.increment();
  }
  bar.stop();
}

async function main() {
  const collections = await getCollectionsFromActivity();

  if (collections.length === 0) {
    console.log('No collections found in activity feed.');
  }

  const choices = collections.map(c => ({ name: c.name, value: c }));
  choices.push(new inquirer.Separator());
  choices.push({ name: 'Download All Found Collections', value: 'all' });
  choices.push({ name: 'Enter Collection ID/URL Manually', value: 'manual' });

  const { selection } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selection',
      message: 'Select a collection to download:',
      choices: choices
    }
  ]);

  let collectionsToDownload = [];

  if (selection === 'all') {
    collectionsToDownload = collections;
  } else if (selection === 'manual') {
    const { manualInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'manualInput',
        message: 'Enter Collection ID or URL:'
      }
    ]);

    let manualId = manualInput;
    // Try to extract ID from URL if present
    // e.g. https://manikrathee.dropmark.com/12345
    const urlMatch = manualInput.match(/dropmark\.com\/(\d+)/);
    if (urlMatch) {
      manualId = urlMatch[1];
    }

    // Fetch info to get name
    const data = await fetchCollectionItems(manualId);
    if (data) {
      collectionsToDownload.push({
        id: manualId,
        name: data.name || `Collection-${manualId}`,
        url: `${BASE_URL}/${manualId}`
      });
    } else {
      console.error('Invalid collection ID or unauthorized.');
      return;
    }
  } else {
    collectionsToDownload = [selection];
  }

  const timestamp = format(new Date(), 'yyyyMMdd - HH:mm');
  const downloadDir = path.join(os.homedir(), 'Downloads', `Dropmark Download ${timestamp}`);

  console.log(`\nDownloading to: ${downloadDir}`);
  await fs.ensureDir(downloadDir);

  for (const collection of collectionsToDownload) {
    await processCollection(collection, downloadDir);
  }

  console.log('\nDone!');
}

main();
