# Gangster Revival

Fanouškovský privátní server pro **Goodgame Gangster** (dříve *Goodgame Mafia*, Goodgame Studios, 2010–2020), hratelný znovu v prohlížeči přes [Ruffle](https://ruffle.rs).

> Neoficiální projekt, není nijak spojený s Goodgame Studios ani se Stillfront. Herní soubory (klient, grafika) v repozitáři **nejsou**. Instalační skript si je stáhne z veřejného archivu ([Internet Archive – Goodgame Gangster Desktop](https://archive.org/details/goodgame-gangster-installer)). Server je napsaný od nuly podle toho, jak se chová původní klient.

```
prohlížeč ── Ruffle (WASM) ── GoodgameGangster.swf (originální klient 2.4.5)
   │  HTTP: /game/*  (SWF, avatary, item knihovny – komprimováno Brotli)
   │  HTTP: /cdn/*   (emulace gangster-*.goodgamestudios.com: server list, země, texty, CookieSaver.swf)
   └─ WebSocket /ws ─┐
                     ├── Node.js server: SmartFoxServer 1.x protokol (XML + %xt%) + protobuf
desktop AIR klient ──┘   TCP :9339
```

## Rychlý start

Potřebuješ jen [Node.js](https://nodejs.org) 18 nebo novější.

```bash
cd gangster-revival
npm install
npm run setup        # stáhne instalačku z Internet Archive (12 MB) a rozbalí hru do ./client
npm start            # http://localhost:8080
```

Otevři **http://localhost:8080**, vytvoř si postavu → *Register* → vyplň jméno, e-mail a heslo → hraješ.

Pokud už instalačku máš: `npm run setup -- --from cesta/GoodgameGangster_installer.exe`.

## Co funguje

✅ = vyzkoušeno v prohlížeči · 🟡 = naprogramováno na serveru, v prohlížeči zatím neověřeno · ❌ = chybí

| Oblast | Stav |
|---|---|
| Načtení hry v prohlížeči (Ruffle), přesměrování CDN adres, WebSocket místo TCP | ✅ |
| Vytvoření postavy, registrace, přihlášení | ✅ |
| Profil, atributy, level, XP, energie misí a její regenerace | ✅ |
| Obchod: nákup přetažením do inventáře, vyprodaný slot, odpočet nového zboží | ✅ |
| Obchod: prodej, nové zboží za zlato, sejf | 🟡 |
| Inventář, výzbroj (grid), vybavení (8 slotů: auto, dům, mazlíček…), přepočet atributů | ✅ |
| Jídlo, odemčení řádku inventáře za zlato, vylepšení atributu tlačítkem + | 🟡 |
| Mise u Kmotra: start, odpočet, dokončení, přehrání souboje s NPC, odměna | ✅ |
| Mise: „dokončit hned“ za zlato | 🟡 |
| PvP duel: výběr soupeře, příprava, souboj, výsledek (honor, cash) | ✅ |
| Žebříček, práce (výpalné), doplnění energie za zlato | 🟡 |
| 40 botů různých levelů, aby server nebyl prázdný | ✅ |
| Rodiny (clany), gang war, survival, wanted, eventy, questy, zprávy, gang members | ❌ (klient dostane prázdnou odpověď `OK`, aby nezamrzl) |
| Originální desktop (AIR) klient přes TCP | 🟡 handshake ověřen raw TCP testem |

Hodnoty (ceny, síla předmětů, XP tabulka, odměny) původně žily jen na serveru Goodgame a nikde se nedochovaly, proto jsou dopočítané vzorci v `server/game/rules.js` a `server/game/items.js`. Seznam existujících předmětů server čte přímo z grafické knihovny klienta.

## Texty / jazyky

Texty hry byly v souboru `games-languages/4/<jazyk>.ggs` na CDN Goodgame, který v instalačce **není**. Bez něj server generuje náhradní anglické texty (rozumné popisky hlavních obrazovek, názvy předmětů typu „Pistol #12“, jména nepřátel). Pro originální texty (včetně **češtiny** – `cs.ggs`):

1. `npm run setup` se je pokusí stáhnout z Wayback Machine automaticky (`--langs en,cs,de`).
2. Případně ručně: otevři
   `https://web.archive.org/web/2019*/gangster-data.goodgamestudios.com/games-languages/4/*`,
   stáhni `en.ggs` / `cs.ggs` a ulož je do `data/languages/`.
3. Restartuj server. Jazyk se volí v pravém horním rohu stránky.

## Nastavení (proměnné prostředí)

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT` | `8080` | HTTP port (web + WebSocket `/ws`) |
| `TCP_PORT` | `9339` | TCP port pro desktop klienta (`0` = vypnout) |
| `SOCKET_HOST` / `SOCKET_PORT` | `127.0.0.1` / `9339` | adresa, kterou server posílá klientovi v seznamu serverů |
| `SERVER_NAME` | `Gangster Revival` | název serveru |
| `START_CASH` / `START_GOLD` | `1000` / `100` | počáteční peníze |
| `TIME_SCALE` | `1` | násobič délky misí (`0.1` = 10× rychleji) |
| `LOG_LEVEL` | `info` | `debug` vypíše celou komunikaci s klientem |
| `DATA_DIR` | `./data` | databáze hráčů (`db.json`) a jazykové soubory |

Ladění klienta: `http://localhost:8080/?debug=1` zapne výpis `trace()` z klienta do konzole prohlížeče (vidíš i každou přijatou protobuf zprávu).

## Nasazení na internet

Za reverzní proxy s HTTPS (nginx, Caddy, Cloudflare Tunnel…) stačí přeposlat HTTP i WebSocket na port 8080. Stránka sama pozná `https` a připojí se přes `wss://<doména>/ws` (hlavička `X-Forwarded-Proto`). Příklad pro Caddy:

```
gangster.example.com {
    reverse_proxy localhost:8080
}
```

## Správa hráčů

Při vypnutém serveru:

```bash
npm run admin -- list
npm run admin -- set Jmeno level 20
npm run admin -- set Jmeno gold 5000
npm run admin -- password Jmeno noveHeslo
npm run admin -- ban Jmeno 24        # hodin, 0 = zrušit
```

## Originální desktop klient (experimentální)

Desktopová AIR verze (z instalačky) se připojuje na TCP `SOCKET_HOST:SOCKET_PORT` a stahuje konfiguraci z `gangster-*.goodgamestudios.com`. Server ty cesty obsluhuje i bez prefixu `/cdn`, takže stačí v souboru hosts přesměrovat `gangster-data.goodgamestudios.com`, `gangster-files.goodgamestudios.com`, `gangster-content.goodgamestudios.com` a `gangster-account.goodgamestudios.com` na server a pustit ho s `PORT=80`. Tahle cesta zatím není otestovaná, hlavní cíl je prohlížeč.

## Struktura

```
server/
  index.js            HTTP + WebSocket + TCP
  http.js             statické soubory, Brotli/gzip, emulace CDN
  cdn.js              server list, země, jazykový soubor, CookieSaver.swf
  swfgen.js           ručně sestavený AS3 CookieSaver.swf (originál chybí)
  protocol/sfs.js     SmartFoxServer 1.x framing (XML sys zprávy, %xt% zprávy)
  protocol/pb.js      protobuf kodek řízený schématem
  data/pbschema.json  268 protobuf zpráv + 120 enumů vytažených z klienta
  data/commands.json  mapování příkaz → třída požadavku/odpovědi (157 příkazů)
  game/               herní logika (účty, inventář, obchody, mise, souboje, boti)
tools/
  setup.js            stažení a rozbalení klienta
  admin.js            správa hráčů
  re/                 vlastní SWF/ABC parser, pseudo-dekompilátor a extraktor protobuf schémat
```

Rozšiřování: nová funkce = nový handler v `server/game/*.js` (`xtHandlers.<příkaz>` nebo `pbHandlers.<příkaz>`). Formát dat zjistíš v dekompilovaném klientovi:

```bash
python3 -I tools/re/pseudo.py client/GoodgameGangster.swf /tmp/as   # čitelný pseudo-kód všech tříd
python3 -I tools/re/pbschema.py client/GoodgameGangster.swf schema.json
```

Neimplementované příkazy server loguje (`unimplemented command …`) a na protobuf příkazy odpovídá prázdnou odpovědí s `result: OK`, aby klient nezamrzl.

## Poděkování

- [Ruffle](https://ruffle.rs) – Flash emulátor v Rustu/WASM
- [glennhenry/Goodgame-Gangster-Server](https://github.com/glennhenry/Goodgame-Gangster-Server) – první pokus o emulátor; jeho poznámky o průběhu přihlášení a zachycené zprávy z originálního serveru pomohly ověřit protokol
- Internet Archive za zachování instalačky
