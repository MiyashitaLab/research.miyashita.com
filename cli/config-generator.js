const YAML = require('yamljs');
const fs = require('fs');

const example = YAML.parse(fs.readFileSync('./config/example.yml', 'utf8'));
const data = YAML.parse(fs.readFileSync('./config/data.yml', 'utf8'));

fs.writeFileSync('./config/data.json', JSON.stringify(Object.assign(example, data)));
