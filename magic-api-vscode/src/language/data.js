"use strict";

const languageData = require("../language-data/generated/core.json");

function loadLanguageData() {
  return languageData;
}

module.exports = {
  loadLanguageData
};
