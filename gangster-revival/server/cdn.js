// Emulates the Goodgame CDN hosts the client loads its configuration from
// (gangster-data/-files/-content/-account.goodgamestudios.com). In the browser,
// Ruffle's urlRewriteRules redirect those hosts to /cdn/ on this server.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCookieSaverSwf } from './swfgen.js';
import { config } from './config.js';
import { generatedItemNames } from './game/items.js';

const fallbackTexts = JSON.parse(readFileSync(new URL('./data/texts-fallback.json', import.meta.url), 'utf8'));
const overrideTexts = JSON.parse(readFileSync(new URL('./data/texts-en.json', import.meta.url), 'utf8'));

// country code -> [language, browser codes, flash code, tz start, tz end]
const COUNTRIES = {
  GB: ['en', 'en,en-GB', 'en', 0, 0], US: ['en', 'en-US', 'en', -10, -5], DE: ['de', 'de,de-DE,de-AT,de-CH', 'de', 1, 1],
  CZ: ['cs', 'cs,cs-CZ', 'cs', 1, 1], SK: ['sk', 'sk,sk-SK', 'sk', 1, 1], PL: ['pl', 'pl,pl-PL', 'pl', 1, 1],
  FR: ['fr', 'fr,fr-FR', 'fr', 1, 1], IT: ['it', 'it,it-IT', 'it', 1, 1], ES: ['es', 'es,es-ES', 'es', 1, 1],
  NL: ['nl', 'nl,nl-NL', 'nl', 1, 1], PT: ['pt', 'pt,pt-PT', 'pt', 0, 0], RU: ['ru', 'ru,ru-RU', 'ru', 3, 12],
  TR: ['tr', 'tr,tr-TR', 'tr', 2, 2], NO: ['no', 'no,nb,nn', 'no', 1, 1], GR: ['el', 'el,el-GR', 'el', 2, 2],
  FI: ['fi', 'fi,fi-FI', 'fi', 2, 2], SE: ['sv', 'sv,sv-SE', 'sv', 1, 1], HU: ['hu', 'hu,hu-HU', 'hu', 1, 1],
  DK: ['da', 'da,da-DK', 'da', 1, 1], JP: ['ja', 'ja,ja-JP', 'ja', 9, 9], KR: ['ko', 'ko,ko-KR', 'ko', 9, 9],
};

export function countryXml() {
  const rows = Object.entries(COUNTRIES).map(([code, [lang, browser, flash, tzs, tze]]) =>
    `<c><country>${code}</country><browserCodes>[${browser}]</browserCodes><flashCode>${flash}</flashCode>` +
    `<lang>${lang}</lang><timezoneStart>${tzs}</timezoneStart><timezoneEnd>${tze}</timezoneEnd></c>`);
  return `<?xml version="1.0" encoding="UTF-8"?><countries>${rows.join('')}</countries>`;
}

export function networkXml() {
  const countries = JSON.stringify(Object.keys(COUNTRIES));
  return `<?xml version="1.0" encoding="UTF-8"?><network>
<general>
<defaultinstance>1</defaultinstance><networkname>${config.serverName}</networkname>
<allowedfullscreen>true</allowedfullscreen><usekeybaselogin>false</usekeybaselogin>
<networkbuddies>false</networkbuddies><enablefeedmessages>false</enablefeedmessages>
<enablelonelycow>false</enablelonelycow><requestpaybyjs>false</requestpaybyjs>
<networknewsbyjs>false</networknewsbyjs><earncredits>0</earncredits>
<useexternallinks>false</useexternallinks><invitefriends>false</invitefriends>
<maxusernamelength>20</maxusernamelength><usepayment>false</usepayment><showversion>true</showversion>
</general>
<instances>
<instance value="1"><server>${config.socketHost}</server><port>${config.socketPort}</port><zone>${config.zone}</zone>
<maintenance>0</maintenance><instanceName>1</instanceName><isInternational>1</isInternational><isFavorite>1</isFavorite>
<defaultcountry>default</defaultcountry><instanceLocaId>${config.serverName}</instanceLocaId><countries>${countries}</countries></instance>
</instances>
</network>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Language file generated from the fallback text list when the original one is not available. */
const ENEMY_FIRST_M = ['Tony', 'Vito', 'Sal', 'Frankie', 'Johnny', 'Mickey', 'Carlo', 'Nicky', 'Benny', 'Paulie', 'Joey', 'Sonny',
  'Vinnie', 'Rocco', 'Enzo', 'Luca', 'Marco', 'Bruno', 'Dino', 'Gino', 'Aldo', 'Fredo', 'Tommy', 'Eddie', 'Lenny', 'Moe', 'Sammy',
  'Jimmy', 'Max', 'Leo', 'Wong', 'Chen', 'Lee', 'Kenji', 'Hiro', 'Jun', 'Feng', 'Bao', 'Tao', 'Ming', 'Kai', 'Yuki', 'Shin', 'Jin', 'Ren'];
const ENEMY_FIRST_F = ['Rosa', 'Lola', 'Gina', 'Maria', 'Carla', 'Lucia', 'Sofia', 'Bella', 'Nina', 'Tina', 'Vera', 'Donna', 'Angie',
  'Dolly', 'Ruby', 'Ivy', 'Pearl', 'Daisy', 'Stella', 'Greta', 'Paula', 'Mia', 'Zoe', 'Eva', 'Lily', 'Kitty', 'Roxy', 'Bonnie',
  'Clara', 'Ida', 'Mei', 'Lin', 'Yan', 'Hua', 'Li', 'Xia', 'Ling', 'Suki', 'Aiko', 'Hana', 'Rin', 'Yoko', 'Emi', 'Nori', 'Kiko'];
const ENEMY_LAST = ['Bones', 'Knuckles', 'Moretti', 'Barzini', 'Russo', 'Gallo', 'Esposito', 'Romano', 'Ricci', 'Greco', 'Bruno',
  'Conti', 'De Luca', 'Mancini', 'Lombardi', 'Ferrari', 'Rizzo', 'Marino', 'Costa', 'Fontana', 'Caruso', 'Vitale', 'Santoro',
  'Leone', 'Longo', 'Gentile', 'Martini', 'Morelli', 'Ferri', 'Testa', 'Malone', 'Murphy', "O'Hara", 'Kelly', 'Doyle', 'Flynn',
  'Burke', 'Quinn', 'Walsh', 'Ryan', 'Dunn', 'Nolan', 'Hayes', 'Lynch', 'Byrne', 'Fox', 'Shaw', 'Cole', 'Black', 'Stone', 'Wolf',
  'Hawk', 'Crane', 'Steel', 'Diamond', 'Silver', 'Gold', 'Cash', 'Sharp', 'Slick', 'Wang', 'Zhang', 'Liu', 'Yang', 'Huang',
  'Zhao', 'Wu', 'Zhou', 'Xu', 'Sun', 'Ma', 'Hu'];

function enemyNames() {
  const out = {};
  ENEMY_FIRST_M.forEach((n, i) => { out[`MafiaEnemyName_male_${i + 1}`] = n; });
  ENEMY_FIRST_F.forEach((n, i) => { out[`MafiaEnemyName_female_${i + 1}`] = n; });
  ENEMY_LAST.forEach((n, i) => { out[`MafiaEnemyName_surname_${i + 1}`] = n; });
  return out;
}

export function generatedLanguageXml() {
  const texts = { ...fallbackTexts, ...generatedItemNames(), ...enemyNames(), ...overrideTexts };
  const rows = Object.entries(texts).map(([id, name]) => `<t id="${escapeXml(id)}" name="${escapeXml(name)}"/>`);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><root><texts>${rows.join('\n')}</texts></root>`, 'utf8');
}

let generatedCache;
/**
 * Original language files (Mafia_<lang>.xml zipped as <lang>.ggs) can be dropped into
 * data/languages/. Without them the generated English fallback is served.
 */
export function languageFile(lang, ext) {
  const dir = config.langDir || join(config.dataDir, 'languages');
  for (const name of [`${lang}.${ext}`, `${lang}.ggs`, `${lang}.xml`, 'en.ggs', 'en.xml']) {
    const p = join(dir, name);
    if (existsSync(p)) return { body: readFileSync(p), type: name.endsWith('.xml') ? 'text/xml' : 'application/octet-stream' };
  }
  generatedCache ??= generatedLanguageXml();
  return { body: generatedCache, type: 'text/xml' };
}

let cookieSaver;
export function cookieSaverSwf() {
  cookieSaver ??= buildCookieSaverSwf();
  return cookieSaver;
}
