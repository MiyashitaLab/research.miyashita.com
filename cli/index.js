const _ = require('lodash');
const { default: axios } = require('axios');
const fs = require('fs-promise');
const { sync: exists } = require('exists-file');
const url = require('url');
const path = require('path');
const moment = require('moment');
const YAML = require('yamljs');
const pug = require('pug');
const Jimp = require('jimp');
const config = require('../config/data.json');

const compileInfoHTML = pug.compileFile('./src/_info.pug');
const compileIndexHTML = pug.compileFile('./src/index.pug');
const compileListOfYearsHTML = pug.compileFile('./src/_list_of_years.pug');
const compileYearHTML = pug.compileFile('./src/_year.pug');
const compileSitemapXML = pug.compileFile('./src/_sitemap.pug');

const GDriveFileIdRegExp = /([\w_-]{28,})/;
const DropBoxFileIdRegExp = /([\w_-]{15,})/;

async function fetchFromGDriveURL(GDriveURL) {
  if (!GDriveFileIdRegExp.test(GDriveURL)) {
    return Promise.resolve({ data: false });
  }
  const fileId = GDriveURL.match(GDriveFileIdRegExp)[1];
  return axios.request({
    method: 'GET',
    url: `https://docs.google.com/uc?id=${fileId}&export=download`,
    responseType: 'arraybuffer',
  });
}

async function fetchFromDropBoxURL(DropBoxURL) {
  if (!DropBoxFileIdRegExp.test(DropBoxURL)) {
    return Promise.resolve({ data: false });
  }
  const fileId = DropBoxURL.match(DropBoxFileIdRegExp)[1];
  return axios.request({
    method: 'GET',
    url: `https://www.dropbox.com/s/${fileId}/_.pdf?dl=1`,
    responseType: 'arraybuffer',
  });
}

async function fetchFromURL(fileURL) {
  const parsed = url.parse(fileURL);
  if (parsed.hostname.match(/google/)) {
    return fetchFromGDriveURL(fileURL);
  } else if (parsed.hostname.match(/dropbox/)) {
    return fetchFromDropBoxURL(fileURL);
  }
  return Promise.resolve({ data: false });
}

async function fetchEntriesFromGSheet({ spreadID, sheetID }) {
  const { data: rawData } =
    await axios.request({
      method: 'GET',
      url: `https://spreadsheets.google.com/feeds/list/${spreadID}/${sheetID}/public/values?alt=json`,
    });

  const entries = rawData.feed.entry.slice(1).map((entry) => {
    const keys = Object.keys(entry).filter((k) => k.match(/^gsx\$/));
    const obj = {};
    keys.forEach((key) => {
      const newKey = key.replace(/^gsx\$/, '').replace(/-/g, '_');
      obj[newKey] = entry[key].$t;

      switch (obj[newKey]) {
        case 'TRUE': {
          obj[newKey] = true;
          break;
        }
        case 'FALSE': {
          obj[newKey] = false;
          break;
        }
        default:
      }
    });
    return obj;
  });

  return entries;
}

function getSaveDirPath(entry) {
  const year = moment(entry.issued, 'YYYY/MM/DD').year();
  const dirPath = path.join('./data', `./${year}/${entry.id}`);
  return dirPath;
}

async function fetchPDF(entry) {
  if (!entry.available_pdf || !entry.pdf_url) {
    return false;
  }

  const PDFPath = path.join(getSaveDirPath(entry), `${entry.id}.pdf`);
  if (exists(PDFPath)) {
    return true;
  }

  const { data: PDFData } = await fetchFromURL(entry.pdf_url);
  if (!PDFData) {
    console.error(`Can't fetch.: ${entry.pdf_url}`);
    return false;
  }
  await fs.writeFile(PDFPath, PDFData);
  return true;
}

async function fetchThumbnail(entry) {
  let arraybuffer;

  const fetchConfig = { responseType: 'arraybuffer' };
  if (entry.youtube_url) {
    const id = url.parse(entry.youtube_url, true).query.v;
    const baseUrl = `https://img.youtube.com/vi/${id}/`;
    const { data } =
      await axios.get(url.resolve(baseUrl, 'maxresdefault.jpg'), fetchConfig)
        .catch(() => axios.get(url.resolve(baseUrl, 'sddefault.jpg'), fetchConfig))
        .catch(() => axios.get(url.resolve(baseUrl, 'hqdefault.jpg'), fetchConfig))
        .catch(() => Promise.resolve({ data: false }));
    arraybuffer = data;
  } else if (entry.thumbnail_url) {
    const { data } =
      await axios.get(entry.thumbnail_url, fetchConfig)
        .catch(() => Promise.resolve({ data: false }));
    arraybuffer = data;
  }

  if (!arraybuffer) {
    return false;
  }
  const image = await Jimp.read(Buffer.from(arraybuffer));

  await new Promise((resolve, reject) => {
    image.getBuffer(Jimp.MIME_JPEG, (err, buffer) => {
      if (err) return reject(err);
      return resolve(buffer);
    });
  })
  .then((buffer) => fs.writeFile(path.join(getSaveDirPath(entry), 'thumb.jpg'), buffer));

  await new Promise((resolve, reject) => {
    image.resize(Jimp.AUTO, 180).getBuffer(Jimp.MIME_JPEG, (err, buffer) => {
      if (err) return reject(err);
      return resolve(buffer);
    });
  })
  .then((buffer) => fs.writeFile(path.join(getSaveDirPath(entry), 'thumb-small.jpg'), buffer));

  return true;
}

function generateCitation(info) {
  const punc = (info.author.every((author) => author.match(/^\w+$/))) ? [',', '.'] : ['，', '．'];
  const author = `${info.author.join(`${punc[0]}\x20`)}${punc[1]}`;
  const arr = [
    info.title,
    info.container_title,
    info.volume && `Vol.${info.volume}`,
    info.issue && `Issue.${info.issue}`,
    info.number && `No.${info.number}`,
    info.page && `pp.${info.page}`,
    info.issued && `${info.issued.split('/').shift()}`,
  ].filter((item) => !!item);

  return `${author} ${arr.join(`${punc[0]}\x20`)}${punc[1]}`;
}

async function convertEntry(originalEntry) {
  const entry = Object.assign({}, originalEntry);
  const YAMLPath = path.join(getSaveDirPath(entry), './info.yml');

  entry.author = entry.author.split(/[;\n]/).map((a) => a.trim());
  entry.keywords =
    entry.keywords.split(/[;\n]/).map((k) => k.trim()).filter((k) => !!k);
  if (!entry.external_url && entry.doi) {
    entry.external_url = `http://doi.org/${entry.doi}`;
  }
  entry.links = [];

  const pageURL =
    url.resolve(config.general.siteUrl, path.join(path.relative('./data', getSaveDirPath(entry)), './'));
  if (entry.available_pdf && entry.pdf_url) {
    entry.pdf_url = url.resolve(pageURL, `./${entry.id}.pdf`);
  }
  entry.url = pageURL;

  if (exists(YAMLPath)) {
    const oldEntry = YAML.parse(await fs.readFile(YAMLPath, 'utf8'));
    entry.links = _.defaultsDeep(entry.links, oldEntry.links);
  }

  Object.assign(entry, { citation: generateCitation(entry) });

  return entry;
}

async function saveEntryAsYAML(entry) {
  const YAMLPath = path.join(getSaveDirPath(entry), './info.yml');
  await fs.writeFile(YAMLPath, YAML.stringify(entry, Number.MAX_SAFE_INTEGER, 2));
}

function objectToBibTeX(obj) {
  const type = obj.type;
  const id = obj.id;
  const info = Object.assign({}, obj, {
    type: null,
    id: null,
  });

  const bibTeXLines =
    Object.keys(info).filter((key) => info[key])
      .map((key) => `${key} = "${info[key]}"`);

  return [
    `@${type} {${id}`,
    ...bibTeXLines,
    '}',
  ].join('\n');
}

async function generateBibTeX(info) {
  const obj = {
    id: info.id,
    author: info.author.join(' and '),
    title: info.title,
    year: moment(info.issued, 'YYYY/MM/DD').year(),
    month: moment(info.issued, 'YYYY/MM/DD').month(),
  };

  if (info.type === 'paper-conference') {
    Object.assign(obj, {
      type: 'inproceedings',
      booktitle: info.container_title,
      pages: info.page,
      publisher: info.publisher,
    });
  }

  if (info.type === 'article-journal') {
    Object.assign(obj, {
      type: 'article',
      journal: info.container_title,
      pages: info.page,
      volume: info.volume,
      number: info.issue,
    });
  }

  if (info.type === 'report') {
    Object.assign(obj, {
      type: 'techreport',
      institution: info.institution,
      pages: info.page,
      number: info.issue || info.number,
    });
  }

  if (info.type === 'thesis') {
    Object.assign(obj, {
      type: 'mastersthesis',
      school: info.institution,
    });
  }

  const bibTeXData = objectToBibTeX(obj);
  const bibTeXPath = path.join(getSaveDirPath(info), './bibtex.bib');
  await fs.writeFile(bibTeXPath, bibTeXData);
}

async function generateCSLJSON(info) {
  const obj = _.cloneDeep(info);

  obj.author = obj.author.map((name) => {
    if (name.match(/\w+\s+\w+/)) {
      return {
        family: name.split(/\s+/).pop(),
        given: name.split(/\s+/).shift(),
      };
    }
    return { literal: name };
  });
  obj.keyword = obj.keywords.join('; ');

  ['doi', 'isbn', 'issn'].forEach((key) => {
    obj[key.toUpperCase()] = obj[key];
  });

  const csl = {};
  [
    'id', 'type', 'title', 'author', 'abstract', 'container_title',
    'issued', 'volume', 'issue', 'number', 'page', 'publisher',
    'keyword', 'language', 'DOI', 'ISBN', 'ISSN',
  ].forEach((key) => {
    if (obj[key]) {
      const newKey = key.replace(/_/g, '-');
      csl[newKey] = obj[key];
    }
  });

  const CSLData = JSON.stringify([csl], null, 2);
  const CSLPath = path.join(getSaveDirPath(info), './csl.json');
  await fs.writeFile(CSLPath, CSLData);
}

async function generateHTML(info) {
  const HTMLPath = path.join(getSaveDirPath(info), './index.html');
  const HTMLData = compileInfoHTML(Object.assign({}, config, { info }));
  await fs.writeFile(HTMLPath, HTMLData);
}

(async function main() {
  const entries = await fetchEntriesFromGSheet({
    spreadID: '1n1Z_KQAOZ-ZQpCAHx_6YFoO0z_tKfSXXwdf_vZijOWk',
    sheetID: 'otu50x0',
  });

  const indexEntries = [];
  for (const entry of entries) {
    if (entry.draft) {
      await fs.remove(getSaveDirPath(entry));
      continue;
    }
    if (entry.available_pdf && !entry.pdf_url) {
      await fs.remove(getSaveDirPath(entry));
      continue;
    }

    await fs.mkdirs(getSaveDirPath(entry));
    await fetchPDF(entry);
    const converted = await convertEntry(entry);
    if (await fetchThumbnail(converted)) {
      converted.ogp_image = url.resolve(converted.url, 'thumb.jpg');
      converted.small_thumbnail = url.resolve(converted.url, 'thumb-small.jpg');
    }
    await saveEntryAsYAML(converted);
    await generateBibTeX(converted);
    await generateCSLJSON(converted);
    await generateHTML(converted);

    indexEntries.push({
      author: converted.author,
      title: converted.title,
      year: moment(converted.issued, 'YYYY/MM/DD').year(),
      date: moment(converted.issued, 'YYYY/MM/DD'),
      url: converted.url,
      small_thumbnail: converted.small_thumbnail,
    });
  }

  const indexConfig = Object.assign({}, config, {
    researchList: indexEntries.sort((a, b) => b.date - a.date),
  });

  const indexHTMLPath = './dist/index.html';
  const indexHTMLData = compileIndexHTML(indexConfig);
  await fs.writeFile(indexHTMLPath, indexHTMLData);

  const yearInfoList = Array.from(new Set(indexEntries.map((entry) => entry.year)))
    .map((year) => ({
      year,
      url: url.resolve(config.general.siteUrl, `/${year}/`),
    }));

  await fs.mkdirs('./dist/list_of_years');
  const listOfYearsHTMLPath = './dist/list_of_years/index.html';
  const listOfYearsHTMLData = compileListOfYearsHTML(Object.assign({}, config, {
    url: url.resolve(config.general.siteUrl, '/list_of_years/'),
    yearInfoList,
  }));
  await fs.writeFile(listOfYearsHTMLPath, listOfYearsHTMLData);

  for (const yearInfo of yearInfoList) {
    await fs.mkdirs(`./dist/${yearInfo.year}`);
    const researchList = indexEntries
      .filter((entry) => entry.year === yearInfo.year)
      .sort((a, b) => b.date - a.date);
    const yearHTMLPath = `./dist/${yearInfo.year}/index.html`;
    const yearHTMLConfig = Object.assign({}, config, yearInfo, {
      researchList,
    });
    const yearHTMLData = compileYearHTML(yearHTMLConfig);
    await fs.writeFile(yearHTMLPath, yearHTMLData);
  }

  const sitemapXMLPath = './dist/sitemap.xml';
  const sitemapList = [
    { url: config.general.siteUrl },
    { url: url.resolve(config.general.siteUrl, '/list_of_years/') },
    ...yearInfoList,
    ...indexEntries,
  ];
  const sitemapXMLData = compileSitemapXML({
    sitemapList,
  });
  await fs.writeFile(sitemapXMLPath, sitemapXMLData);

  return true;
}())
.catch((err) => {
  console.error(err.stack || err);
  process.abort();
});

