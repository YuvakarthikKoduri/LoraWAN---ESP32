/*
  ESP32 + LoRa SX1278 — WAN Chat v4.0 (Enhanced UI)
  Features: User IDs, Admin, P2P/Group/Broadcast, SOS+GPS, AES-128, Test Mode
  Wiring: NSS=D5(GPIO5) RST=D14(GPIO14) DIO0=D4(GPIO4) SCK=D18 MISO=D19 MOSI=D23
  Antenna: 17.3cm copper wire on Ra-02 ANT pad (3.3V ONLY!)
  GPS: Uses phone's browser Geolocation API (no hardware GPS needed)
*/
#include <LoRa.h>
#include <SPI.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <mbedtls/aes.h>

// ========== CONFIGURATION ==========
const char *NODE_NAME = "Node-A";   // "Node-B" for 2nd board
const char *AP_SSID = "LoRaChat-A"; // "LoRaChat-B" for 2nd board
const char *AP_PASS = "12345678";
const char *ADMIN_KEY = "admin123";
#define TEST_MODE false // SET TO false FOR REAL LORA! true=no LoRa HW
const uint8_t AES_KEY[16] = {'L', 'o', 'R', 'a', 'C', 'h', 'a', 't',
                             'K', 'e', 'y', '!', '2', '3', '4', '5'};
#define LORA_SS 5
#define LORA_RST 14
#define LORA_DIO0 4
#define LORA_FREQ 433E6
#define LORA_POWER 20
// Faster profile for practical chat sync across nodes.
// Keep these identical on every node.
#define LORA_BW 125E3
#define LORA_SF 10
#define LORA_CR 5
#define LED_PIN 2
#define MAX_MSG 80
#define MAX_MSG_LEN 180
#define MAX_USERS 20
#define USER_TIMEOUT 300000
// ====================================
struct Msg {
  String sender, suid, text, time, channel, target, prio;
  int rssi;
};
Msg chat[MAX_MSG];
int mc = 0;
struct Usr {
  String name, uid;
  unsigned long seen, joined;
  bool adm, muted;
  int msgs;
};
Usr users[MAX_USERS];
int uc = 0;
int nextId = 1;
struct {
  int tx, rx;
  int prssi;
} st = {0, 0, 0};
bool echoPend = false;
unsigned long echoT = 0;
String echoU, echoTx, echoTg, echoUid;
WebServer server(80);
WebSocketsServer webSocket = WebSocketsServer(81);
DNSServer dnsServer;
const byte DNS_PORT = 53;

void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload,
                    size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    Serial.println("WebSocket client connected");
    break;

  case WStype_DISCONNECTED:
    Serial.println("WebSocket client disconnected");
    break;

  default:
    break;
  }
}
// Signal Finder
bool finderActive = false;
unsigned long finderLastPing = 0;
int finderRSSI = 0;
String finderTarget = "";
int lastRSSI = 0;
unsigned long lastPingTx = 0;
String lastTxMsgPkt = "";
unsigned long lastTxMsgAt = 0;
const unsigned long LORA_TX_GAP_MS = 1400;
const unsigned long LORA_PING_GAP_MS = 15000;
const unsigned long LORA_NODE_LOC_INTERVAL_MS = 15000;
#define LORA_TX_QUEUE_MAX 24
String txQueue[LORA_TX_QUEUE_MAX];
int txQHead = 0;
int txQTail = 0;
int txQCount = 0;
unsigned long lastLoRaTxAt = 0;
// Per-user GPS from helper app
float helperLat[MAX_USERS] = {0};
float helperLon[MAX_USERS] = {0};
bool helperGPS[MAX_USERS] = {false};
float nodeLat = 0.0;
float nodeLon = 0.0;
String uptime() {
  unsigned long s = millis() / 1000;
  char b[12];
  sprintf(b, "%02u:%02u:%02u", (unsigned)(s / 3600 % 24),
          (unsigned)(s / 60 % 60), (unsigned)(s % 60));
  return String(b);
}
void push(const String &sn, const String &uid, const String &tx,
          const String &ch, const String &tg = "", const String &pr = "",
          int rs = 0) {
  if (mc >= MAX_MSG) {
    for (int i = 0; i < MAX_MSG - 1; i++)
      chat[i] = chat[i + 1];
    mc = MAX_MSG - 1;
  }
  chat[mc] = {sn, uid, tx, uptime(), ch, tg, pr, rs};
  mc++;
  Serial.printf("[%s][%s]%s:%s\n", chat[mc - 1].time.c_str(), ch.c_str(),
                sn.c_str(), tx.c_str());

  String incomingMessage = "{";
  incomingMessage += "\"type\":\"chat\",";
  incomingMessage += "\"sender\":\"" + je(sn) + "\",";
  incomingMessage += "\"suid\":\"" + je(uid) + "\",";
  incomingMessage += "\"text\":\"" + je(tx) + "\",";
  incomingMessage += "\"time\":\"" + chat[mc - 1].time + "\",";
  incomingMessage += "\"channel\":\"" + ch + "\",";
  incomingMessage += "\"target\":\"" + je(tg) + "\",";
  incomingMessage += "\"prio\":\"" + pr + "\",";
  incomingMessage += "\"rssi\":" + String(rs);
  incomingMessage += "}";
  webSocket.broadcastTXT(incomingMessage);
}
String je(const String &s) {
  String o = s;
  o.replace("\\", "\\\\");
  o.replace("\"", "\\\"");
  o.replace("\n", "\\n");
  o.replace("\r", "");
  return o;
}
String mkUid() {
  char b[4];
  sprintf(b, "%c%02d", NODE_NAME[5], nextId++);
  return String(b);
}
int findUser(const String &uid) {
  for (int i = 0; i < uc; i++)
    if (users[i].uid == uid)
      return i;
  return -1;
}
int findUserByName(const String &nm) {
  for (int i = 0; i < uc; i++)
    if (users[i].name == nm)
      return i;
  return -1;
}
void cleanUsers() {
  unsigned long now = millis();
  for (int i = 0; i < uc; i++) {
    if (now - users[i].seen > USER_TIMEOUT) {
      push("System", "", users[i].name + " left", "system");
      for (int j = i; j < uc - 1; j++) {
        users[j] = users[j + 1];
        helperLat[j] = helperLat[j + 1];
        helperLon[j] = helperLon[j + 1];
        helperGPS[j] = helperGPS[j + 1];
      }
      helperLat[uc - 1] = 0;
      helperLon[uc - 1] = 0;
      helperGPS[uc - 1] = false;
      uc--;
      i--;
    }
  }
}
bool isAdm(const String &uid) {
  int i = findUser(uid);
  return i >= 0 && users[i].adm;
}
int encAES(const String &p, uint8_t *o, int mx) {
  int l = p.length(), pd = ((l / 16) + 1) * 16;
  if (pd > mx)
    return 0;
  uint8_t *inp = (uint8_t *)calloc(pd, 1);
  if (!inp)
    return 0;
  memcpy(inp, p.c_str(), l);
  uint8_t pv = pd - l;
  for (int i = l; i < pd; i++)
    inp[i] = pv;
  mbedtls_aes_context c;
  mbedtls_aes_init(&c);
  mbedtls_aes_setkey_enc(&c, AES_KEY, 128);
  for (int i = 0; i < pd; i += 16)
    mbedtls_aes_crypt_ecb(&c, MBEDTLS_AES_ENCRYPT, inp + i, o + i);
  mbedtls_aes_free(&c);
  free(inp);
  return pd;
}
String decAES(const uint8_t *b, int l) {
  if (l <= 0 || l % 16)
    return "";
  uint8_t *o = (uint8_t *)malloc(l + 1);
  if (!o)
    return "";
  mbedtls_aes_context c;
  mbedtls_aes_init(&c);
  mbedtls_aes_setkey_dec(&c, AES_KEY, 128);
  for (int i = 0; i < l; i += 16)
    mbedtls_aes_crypt_ecb(&c, MBEDTLS_AES_DECRYPT, b + i, o + i);
  mbedtls_aes_free(&c);
  uint8_t pv = o[l - 1];
  if (pv < 1 || pv > 16) {
    free(o);
    return "";
  }
  for (int i = l - pv; i < l; i++)
    if (o[i] != pv) {
      free(o);
      return "";
    }
  o[l - pv] = '\0';
  String r((char *)o);
  free(o);
  return r;
}
bool sendLoRaNow(const String &pkt) {
  if (TEST_MODE || pkt.length() == 0)
    return false;
  int mx = ((pkt.length() / 16) + 1) * 16;
  uint8_t *b = (uint8_t *)malloc(mx);
  if (!b)
    return false;
  int el = encAES(pkt, b, mx);
  bool ok = false;
  if (el > 0) {
    LoRa.beginPacket();
    LoRa.write(b, el);
    if (LoRa.endPacket() == 1) {
      st.tx++;
      ok = true;
    } else
      Serial.println("[LoRa]TX FAIL");
  }
  free(b);
  return ok;
}
void queueLoRa(const String &pkt, bool highPrio = false) {
  if (TEST_MODE || pkt.length() == 0)
    return;
  if (txQCount >= LORA_TX_QUEUE_MAX) {
    // Keep chat/control responsive by dropping low-priority telemetry first.
    if (!highPrio)
      return;
    txQHead = (txQHead + 1) % LORA_TX_QUEUE_MAX;
    txQCount--;
  }
  if (highPrio) {
    txQHead = (txQHead - 1 + LORA_TX_QUEUE_MAX) % LORA_TX_QUEUE_MAX;
    txQueue[txQHead] = pkt;
  } else {
    txQueue[txQTail] = pkt;
    txQTail = (txQTail + 1) % LORA_TX_QUEUE_MAX;
  }
  txQCount++;
}
void processLoRaTxQueue() {
  if (TEST_MODE || txQCount <= 0)
    return;
  if (millis() - lastLoRaTxAt < LORA_TX_GAP_MS)
    return;
  String pkt = txQueue[txQHead];
  txQHead = (txQHead + 1) % LORA_TX_QUEUE_MAX;
  txQCount--;
  sendLoRaNow(pkt);
  lastLoRaTxAt = millis();
}
void sendLoRa(const String &pkt, bool highPrio = false) {
  // Chat (M|) and ping response (O|) should not be delayed behind GPS chatter.
  bool prio = highPrio || pkt.startsWith("M|") || pkt.startsWith("O|");
  queueLoRa(pkt, prio);
}
// ========== HTML (FULLY FIXED - 100% original content + all quotes fixed)
// ==========
void sendPage() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/html", "");
  server.sendContent(
      F("<!DOCTYPE html><html><head><meta charset=UTF-8><meta name=viewport "
        "content='width=device-width,initial-scale=1,maximum-scale=1'><title>"
        "LoRa WAN Chat</title>"));
  server.sendContent(
      F("<link rel='preconnect' href='https://fonts.googleapis.com'><link "
        "href='https://fonts.googleapis.com/"
        "css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;"
        "500;600;700&display=swap' rel='stylesheet'>"));
  server.sendContent(F("<style>"));
  server.sendContent(F(
      ":root{--bg:#06090f;--s1:#0c1018;--s2:#121a28;--s3:#182030;--bd:#1e2d42;-"
      "-"
      "ac:#5ba3ff;--ac2:#3d8bef;--g:#34d399;--w:#fbbf24;--rd:#ef4444;--tx:#"
      "e2e8f0;--t2:#64748b;--own:#0f2847;--ot:#0f1724;--r:16px;--font:'Inter',"
      "sans-serif;--mono:'JetBrains Mono','Courier New',monospace}"));
  server.sendContent(F(
      "*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);"
      "color:var(--tx);font-family:var(--font);height:100dvh;display:flex;flex-"
      "direction:column;overflow:hidden;-webkit-font-smoothing:antialiased}"));
  server.sendContent(F(
      "#L{display:flex;align-items:center;justify-content:center;height:100dvh;"
      "background:radial-gradient(ellipse at top right,rgba(91,163,255,.05) 0%,"
      "transparent 50%),radial-gradient(ellipse at bottom left,"
      "rgba(52,211,153,.03) 0%,transparent "
      "50%);position:relative;overflow:hidden}"
      ".orb{position:absolute;border-radius:50%;filter:blur(80px);z-index:0;"
      "opacity:.5}"
      "#o1{width:300px;height:300px;background:var(--ac);top:-100px;right:-"
      "100px;"
      "animation:float 10s ease-in-out infinite}"
      "#o2{width:400px;height:400px;background:var(--g);bottom:-150px;left:-"
      "150px;"
      "animation:float 12s ease-in-out infinite reverse}"));
  server.sendContent(F(
      ".lc{background:rgba(12,16,24,.75);backdrop-filter:blur(32px);border:1px "
      "solid rgba(255,255,255,.08);border-radius:32px;padding:48px "
      "36px;width:92%;max-width:380px;text-align:center;box-shadow:0 32px "
      "120px "
      "rgba(0,0,0,.8),inset 0 1px 0 "
      "rgba(255,255,255,.05);position:relative;z-index:1}"));
  server.sendContent(F(
      ".logo-wrap{position:relative;display:inline-block;margin-bottom:12px}"
      ".logo{font-size:64px;display:block;filter:drop-shadow("
      "0 8px 24px rgba(91,163,255,.4));animation:float 4s ease-in-out infinite}"
      ".logo-glow{position:absolute;inset:20%;background:var(--ac);filter:blur("
      "30px);"
      "opacity:.5;border-radius:50%;animation:pulse 3s infinite}"));
  server.sendContent(F(
      ".lc "
      "h1{font-family:var(--mono);font-size:24px;font-weight:700;color:#fff;"
      "letter-spacing:4px;margin:0 0 12px;text-transform:uppercase;"
      "text-shadow:0 2px 12px rgba(91,163,255,.3)}"
      ".badges{display:flex;gap:8px;justify-content:center;margin-bottom:12px}"
      ".badge{font-size:10px;font-family:var(--mono);padding:4px "
      "10px;border-radius:20px;"
      "background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);"
      "color:var(--t2);font-weight:600;letter-spacing:1px}"
      ".lc "
      ".sub{font-size:12px;color:rgba(100,116,139,.8);margin-bottom:32px;"
      "letter-spacing:1px}"));
  server.sendContent(
      F(".in-wrap{position:relative;margin-bottom:16px}"
        ".li{width:100%;background:rgba(0,0,0,.3);border:1px solid "
        "rgba(255,255,255,.1);border-radius:14px;color:var(--tx);font-family:"
        "var(--font);"
        "font-size:15px;padding:16px "
        "18px;outline:none;transition:all "
        ".3s;box-shadow:inset 0 2px 4px "
        "rgba(0,0,0,.2)}.li:focus{border-color:var(--ac);"
        "background:rgba(0,0,0,.5);box-shadow:0 0 0 "
        "4px rgba(91,163,255,.15), inset 0 2px 4px "
        "rgba(0,0,0,.2)}.li::placeholder{color:var(--t2)}"));
  server.sendContent(F(
      ".lb{width:100%;background:linear-gradient(135deg,var(--ac),var(--ac2));"
      "color:#fff;border:none;border-radius:14px;font-family:var(--mono);font-"
      "size:14px;font-weight:700;padding:18px;cursor:pointer;margin-top:8px;"
      "letter-spacing:2px;transition:all .2s;text-transform:uppercase;"
      "box-shadow:0 8px 24px rgba(91,163,255,.3)}.lb:hover{box-shadow:0 12px "
      "32px "
      "rgba(91,163,255,.5);transform:translateY(-2px)}.lb:active{transform:"
      "scale(.97)}"));
  server.sendContent(F(
      ".le{color:var(--rd);font-size:12px;margin-top:12px;min-height:16px;font-"
      "weight:500}.ah{"
      "font-size:11px;color:var(--t2);text-align:left;padding-left:8px;margin-"
      "bottom:8px;font-family:var(--mono);letter-spacing:1px;text-transform:"
      "uppercase;font-weight:600}"));
  server.sendContent(
      F(".gps-p{font-size:11px;color:var(--t2);margin-top:24px;min-"
        "height:16px;font-family:var(--mono);display:flex;align-items:center;"
        "justify-content:center;gap:8px;padding:12px;background:rgba(0,0,0,.2);"
        "border-radius:12px;border:1px solid rgba(255,255,255,.05)}"
        ".gps-dot{width:8px;height:8px;border-radius:50%;background:var(--w);"
        "box-shadow:0 0 10px var(--w);animation:pulse 2s infinite}"
        ".gps-p.ok .gps-dot{background:var(--g);box-shadow:0 0 10px var(--g)}"
        "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}"));
  server.sendContent(F("#C{display:none;flex-direction:column;height:100dvh}"));
  server.sendContent(
      F(".hd{background:rgba(12,16,24,.92);backdrop-filter:blur(16px);border-"
        "bottom:1px solid var(--bd);padding:10px "
        "14px;display:flex;align-items:center;gap:8px;flex-shrink:0}"));
  server.sendContent(
      F(".sg{display:flex;align-items:flex-end;gap:2px;height:16px}.sg "
        "i{width:3px;background:var(--g);border-radius:2px;animation:p 2s "
        "ease-in-out infinite}.sg i:nth-child(1){height:4px}.sg "
        "i:nth-child(2){height:8px;animation-delay:.3s}.sg "
        "i:nth-child(3){height:11px;animation-delay:.6s}.sg "
        "i:nth-child(4){height:16px;animation-delay:.9s}@keyframes "
        "p{0%,100%{opacity:1}50%{opacity:.2}}"));
  server.sendContent(
      F(".hd "
        "h1{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--"
        "ac);letter-spacing:2px;text-transform:uppercase}"));
  server.sendContent(F(
      ".bg{font-family:var(--mono);font-size:9px;font-weight:600;border-radius:"
      "20px;padding:3px "
      "8px;white-space:nowrap}.bf{color:var(--t2);background:rgba(100,116,139,."
      "08);border:1px solid "
      "var(--bd)}.be{color:var(--ac);background:rgba(91,163,255,.08);border:"
      "1px solid "
      "rgba(91,163,255,.15)}.bn{color:var(--g);background:rgba(52,211,153,.08);"
      "border:1px solid "
      "rgba(52,211,153,.2);margin-left:auto}.bt{color:var(--w);background:rgba("
      "251,191,36,.08);border:1px solid rgba(251,191,36,.2)}"));
  server.sendContent(F(
      ".bu{color:var(--tx);background:var(--s2);border:1px solid "
      "var(--bd);cursor:pointer;font-family:var(--mono);font-size:9px;font-"
      "weight:600;border-radius:20px;padding:3px 8px;transition:all "
      ".15s}.bu:hover{border-color:var(--ac)}.lo{font-family:var(--mono);font-"
      "size:8px;font-weight:600;color:var(--rd);background:rgba(239,68,68,.06);"
      "border:1px solid rgba(239,68,68,.15);border-radius:20px;padding:3px "
      "8px;cursor:pointer;transition:all "
      ".15s}.lo:hover{background:rgba(239,68,68,.12)}"));
  server.sendContent(F(
      ".ub{background:var(--s1);border-bottom:1px solid var(--bd);padding:6px "
      "14px;display:flex;gap:6px;overflow-x:auto;flex-shrink:0;align-items:"
      "center;scrollbar-width:none}.ub::-webkit-scrollbar{height:0}"));
  server.sendContent(F(
      ".uc{font-family:var(--mono);font-size:9px;color:var(--tx);background:"
      "var(--s3);border:1px solid var(--bd);border-radius:20px;padding:3px "
      "10px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;"
      "gap:4px;transition:all "
      ".2s}.uc:hover{border-color:var(--ac);background:rgba(91,163,255,.05)}."
      "uc.ad{border-color:rgba(251,191,36,.25)}.uc "
      ".dt{width:6px;height:6px;border-radius:50%;background:var(--g);box-"
      "shadow:0 0 6px "
      "rgba(52,211,153,.4)}.uc.mt{opacity:.35}.ul{font-family:var(--mono);font-"
      "size:9px;color:var(--t2);white-space:nowrap;letter-spacing:.5px}"));
  server.sendContent(F(
      ".tb{background:var(--s1);border-bottom:1px solid "
      "var(--bd);display:flex;padding:0 "
      "14px;flex-shrink:0;gap:2px}.tt{font-family:var(--mono);font-size:10px;"
      "font-weight:600;color:var(--t2);padding:9px "
      "14px;cursor:pointer;border-bottom:2px solid transparent;transition:all "
      ".2s;letter-spacing:.5px}.tt:hover{color:var(--tx)}.tt.on{color:var(--ac)"
      ";border-bottom-color:var(--ac)}"));
  server.sendContent(
      F(".ds{font-family:var(--mono);font-size:9px;color:var(--ac);background:"
        "var(--s2);border:1px solid var(--bd);border-radius:8px;padding:3px "
        "8px;outline:none;margin-left:4px;cursor:pointer}"));
  server.sendContent(F(
      "#cw{flex:1;overflow-y:auto;padding:14px "
      "12px;display:flex;flex-direction:column;gap:6px;scroll-behavior:smooth;"
      "scrollbar-width:thin;scrollbar-color:var(--bd) "
      "transparent}#cw::-webkit-scrollbar{width:3px}#cw::-webkit-scrollbar-"
      "thumb{background:var(--bd);border-radius:3px}"));
  server.sendContent(F(
      ".rw{display:flex;flex-direction:column;max-width:82%;animation:fi .25s "
      "ease both}@keyframes "
      "fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:"
      "translateY(0)}}.rw.ow{align-self:flex-end;align-items:flex-end}.rw.ot{"
      "align-self:flex-start;align-items:flex-start}"));
  server.sendContent(F(
      ".mt{font-family:var(--mono);font-size:9px;color:var(--t2);margin-bottom:"
      "2px;padding:0 6px;display:flex;align-items:center;gap:4px}.rw.ow "
      ".mt{color:rgba(91,163,255,.5)}"));
  server.sendContent(
      F(".bb{padding:10px "
        "14px;border-radius:var(--r);font-size:13.5px;line-height:1.55;word-"
        "break:break-word}.rw.ow .bb{background:var(--own);border:1px solid "
        "rgba(91,163,255,.12);border-bottom-right-radius:4px}.rw.ot "
        ".bb{background:var(--ot);border:1px solid "
        "var(--bd);border-bottom-left-radius:4px}"));
  server.sendContent(F(
      ".rw.dm .bb{border-left:3px solid var(--g)}.rw.bc .bb{border-left:3px "
      "solid var(--w);background:rgba(50,38,12,.5)}.rw.sos .bb{border-left:3px "
      "solid var(--rd);background:rgba(60,15,15,.5);animation:sosPulse 2s "
      "ease-in-out infinite}@keyframes sosPulse{0%,100%{box-shadow:0 0 0 0 "
      "rgba(239,68,68,0)}50%{box-shadow:0 0 12px 2px rgba(239,68,68,.15)}}"));
  server.sendContent(F(
      ".ri{font-family:var(--mono);font-size:8px;color:var(--t2);margin-top:"
      "2px;padding:0 "
      "6px}.sy{align-self:center;font-family:var(--mono);font-size:9.5px;color:"
      "var(--t2);background:rgba(100,116,139,.04);border:1px solid "
      "var(--bd);border-radius:20px;padding:4px 14px;animation:fi .3s ease "
      "both}.mn{color:var(--ac);font-weight:600}"));
  // FIXED: .loc block (was the exact cause of "missing terminating \"
  // character" + rgba error)
  server.sendContent(F(
      ".loc{background:rgba(52,211,153,.06);border:1px solid "
      "rgba(52,211,153,.15);border-radius:12px;padding:10px "
      "12px;margin-top:6px;font-family:var(--mono);font-size:10px;display:flex;"
      "align-items:center;gap:8px;flex-wrap:wrap}"));
  server.sendContent(
      F(".loc .coords{color:var(--g);font-weight:600;word-break:break-all}.loc "
        ".cp{font-size:9px;color:var(--ac);background:rgba(91,163,255,.1);"
        "border:1px solid rgba(91,163,255,.2);border-radius:8px;padding:3px "
        "10px;cursor:pointer;margin-left:auto;transition:all "
        ".15s;font-family:var(--mono);font-weight:600}.loc "
        ".cp:hover{background:rgba(91,163,255,.2)}"));
  server.sendContent(
      F("#ib{background:rgba(12,16,24,.92);backdrop-filter:blur(12px);border-"
        "top:1px solid var(--bd);padding:8px "
        "12px;display:flex;gap:6px;align-items:center;flex-shrink:0}"));
  server.sendContent(
      F("#mi{flex:1;background:var(--bg);border:1.5px solid "
        "var(--bd);border-radius:12px;color:var(--tx);font-family:var(--font);"
        "font-size:13px;padding:10px 14px;outline:none;transition:border-color "
        ".2s,box-shadow .2s}#mi:focus{border-color:var(--ac);box-shadow:0 0 0 "
        "3px rgba(91,163,255,.08)}#mi::placeholder{color:var(--t2)}"));
  server.sendContent(F(
      "#sb{background:linear-gradient(135deg,var(--ac),var(--ac2));color:#"
      "fff;border:none;border-radius:12px;font-family:var(--mono);font-weight:"
      "700;font-size:11px;padding:11px "
      "15px;cursor:pointer;letter-spacing:.5px;transition:all "
      ".15s}#sb:hover{box-shadow:0 2px 12px "
      "rgba(91,163,255,.3)}#sb:active{transform:scale(.95)}#sb:disabled{"
      "background:var(--bd);color:var(--t2);box-shadow:none}"));
  server.sendContent(
      F(".ib-btn{border:none;border-radius:12px;font-size:16px;padding:8px;"
        "cursor:pointer;background:transparent;transition:transform "
        ".15s}.ib-btn:active{transform:scale(.85)}"));
  server.sendContent(
      F(".ss{background:linear-gradient(135deg,var(--rd),#dc2626);color:#fff;"
        "font-size:12px;padding:9px;border-radius:12px;font-weight:700;border:"
        "none;cursor:pointer;transition:all .15s}.ss:hover{box-shadow:0 2px "
        "12px "
        "rgba(239,68,68,.3)}.ss:active{transform:scale(.95)}"));
  server.sendContent(
      F("#ap{position:fixed;left:-300px;top:0;bottom:0;width:290px;background:"
        "rgba(10,14,22,.96);backdrop-filter:blur(24px);border-right:1px solid "
        "var(--bd);z-index:100;transition:left .3s "
        "cubic-bezier(.4,0,.2,1);overflow-y:auto;padding:16px}#ap.on{left:0}"));
  server.sendContent(
      F("#ao{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-"
        "index:99;backdrop-filter:blur(2px)}#ao.on{display:block}"));
  server.sendContent(F(
      ".as{margin-bottom:16px}.at{font-family:var(--mono);font-size:10px;"
      "color:var(--ac);margin-bottom:10px;letter-spacing:1.5px;text-transform:"
      "uppercase;display:flex;justify-content:space-between;align-items:"
      "center;font-weight:600}"));
  server.sendContent(
      F(".ac{background:rgba(12,16,24,.7);border:1px solid "
        "var(--bd);border-radius:12px;padding:12px;margin-bottom:8px}"));
  server.sendContent(
      F(".ar{display:flex;justify-content:space-between;padding:5px "
        "0;border-bottom:1px solid "
        "rgba(30,45,66,.4);font-family:var(--mono);font-size:10px}.ar:last-"
        "child{border:none}.ak{color:var(--t2)}.av{color:var(--tx);font-weight:"
        "600}"));
  server.sendContent(
      F(".au{display:flex;align-items:center;justify-content:space-between;"
        "padding:6px 0;border-bottom:1px solid "
        "rgba(30,45,66,.4);font-family:var(--mono);font-size:10px}"));
  server.sendContent(
      F(".ab{font-size:8px;padding:3px 8px;border-radius:10px;border:1px solid "
        "var(--bd);cursor:pointer;font-family:var(--mono);font-weight:600;"
        "margin-left:4px;background:transparent;transition:all "
        ".15s}.ab.kr{color:var(--rd);border-color:rgba(239,68,68,.2)}.ab.kr:"
        "hover{background:rgba(239,68,68,.1)}.ab.mu{color:var(--w);border-"
        "color: "
        "rgba(251,191,36,.2)}.ab.mu:hover{background:rgba(251,191,36,.1)}"));
  server.sendContent(
      F(".ai{width:100%;background:var(--bg);border:1.5px solid "
        "var(--bd);border-radius:10px;color:var(--tx);font-family:"
        "var(--font);font-size:11px;padding:8px "
        "12px;outline:none;margin-top:8px;transition:border-color "
        ".2s}.ai:focus{border-color:var(--ac)}"));
  server.sendContent(
      F(".ap-b{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}.ap-p{font-"
        "size:9px;padding:4px "
        "10px;border-radius:10px;cursor:pointer;font-family:var(--mono);font-"
        "weight:600;border:1px solid "
        "var(--bd);background:transparent;color:var(--t2);transition:all "
        ".15s}.ap-p:hover{border-color:var(--ac)}.ap-p.on{border-color:var(--"
        "ac);color:var(--ac);background:rgba(91,163,255,.08)}"));
  server.sendContent(
      F(".ap-s{width:100%;padding:8px;border-radius:10px;border:none;font-"
        "family:var(--mono);font-weight:600;font-size:10px;cursor:pointer;"
        "margin-top:"
        "8px;letter-spacing:.5px;transition:all "
        ".15s}.ap-sg{background:linear-gradient(135deg,var(--ac),var(--ac2));"
        "color:#fff}.ap-sg:hover{box-shadow:0 2px 12px "
        "rgba(91,163,255,.3)}.ap-sr{background:var(--rd);color:#fff}.ap-sr:"
        "hover{box-shadow:0 2px 12px "
        "rgba(239,68,68,.3)}.ap-sy{background:var(--s3);color:var(--t2);border:"
        "1px solid var(--bd)}.ap-sy:hover{border-color:var(--ac)}"));
  server.sendContent(
      F(".toast{position:fixed;top:60px;right:14px;background:rgba(12,16,24,."
        "94);backdrop-filter:blur(16px);border:1px solid "
        "var(--bd);border-radius:12px;padding:10px "
        "16px;font-family:var(--mono);font-size:10px;z-index:200;animation:si "
        ".3s cubic-bezier(.4,0,.2,1),fdo .3s ease 3s "
        "forwards;max-width:260px;box-shadow:0 8px 32px "
        "rgba(0,0,0,.4)}@keyframes "
        "si{from{transform:translateX(120%);opacity:0}to{transform:translateX("
        "0);opacity:1}}@keyframes "
        "fdo{to{opacity:0;transform:translateY(-12px)}}"));
  server.sendContent(
      F("#inf{display:none;flex:1;overflow-y:auto;padding:18px "
        "14px}.ic{background:rgba(12,16,24,.8);backdrop-filter:blur(12px);"
        "border:1px solid "
        "var(--bd);border-radius:16px;padding:16px;margin-bottom:12px;"
        "transition:all .2s}.ic:hover{border-color:rgba(91,163,255,.15)}.ic "
        "h3{font-family:var(--mono);font-size:11px;color:var(--ac);margin-"
        "bottom:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:"
        "600}."
        "ir{display:flex;justify-content:space-between;padding:5px "
        "0;border-bottom:1px solid "
        "rgba(30,45,66,.3)}.ir:last-child{border:none}.ik{font-family:var(--"
        "mono);font-size:10px;color:var(--t2)}.iv{font-family:var(--mono);font-"
        "size:"
        "10px;color:var(--tx);font-weight:600}"));
  server.sendContent(
      F("#fp{display:none;position:fixed;bottom:60px;left:12px;"
        "right:12px;background:rgba(10,14,22,.96);backdrop-filter:"
        "blur(20px);border:1px solid "
        "var(--bd);border-radius:16px;padding:16px;z-index:50;"
        "font-family:var(--mono);animation:fi .3s ease}"));
  server.sendContent(
      F(".fb{display:flex;gap:3px;align-items:flex-end;height:24px;margin:8px "
        "0}.fb "
        "i{width:6px;background:var(--bd);border-radius:2px;transition:all "
        ".3s}.fb i.on{background:var(--g)}.fb i:nth-child(1){height:6px}.fb "
        "i:nth-child(2){height:11px}.fb i:nth-child(3){height:17px}.fb "
        "i:nth-child(4){height:24px}"));
  server.sendContent(
      F("#sa{display:none;position:fixed;inset:0;background:rgba("
        "0,0,0,.7);z-index:300;display:none;align-items:center;"
        "justify-content:center;backdrop-filter:blur(4px)}"));
  server.sendContent(
      F(".sac{background:rgba(60,15,15,.95);border:2px solid "
        "var(--rd);border-radius:20px;padding:24px;max-width:320px;width:90%;"
        "text-align:center;animation:sosFlash 1s ease-in-out "
        "infinite;font-family:var(--mono)}@keyframes "
        "sosFlash{0%,100%{border-color:var(--rd);box-shadow:0 0 20px "
        "rgba(239,68,68,.2)}50%{border-color:#ff6b6b;box-shadow:0 0 40px "
        "rgba(239,68,68,.5)}}"));
  server.sendContent(
      F(".sac "
        "h2{color:var(--rd);font-size:16px;margin-bottom:8px;letter-spacing:"
        "2px}.sac .sd{color:var(--tx);font-size:12px;margin:6px "
        "0;line-height:1.5}.sa-btn{margin-top:12px;padding:8px "
        "20px;background:var(--rd);color:#fff;border:none;border-radius:10px;"
        "font-family:var(--mono);font-weight:600;cursor:pointer;font-size:"
        "11px}"));
  server.sendContent(F("</style></head><body>"));
  server.sendContent(F(
      "<div id=L><div class=orb id=o1></div><div class=orb id=o2></div>"
      "<div class=lc><div class=logo-wrap><span "
      "class=logo>\xF0\x9F\x93\xA1</span><div class=logo-glow></div></div>"
      "<h1>LoRa Chat</h1><div class=badges><span class=badge>v5.1 "
      "Pro</span><span class=badge id=l-nd></span></div><p class=sub>"
      "Encrypted P2P Radio \xC2\xB7 433 MHz \xC2\xB7 GPS</p>"
      "<div class=in-wrap><input class=li id=un placeholder='Enter your rank "
      "or name...' "
      "maxlength=20 autocomplete=off></div><div class=in-wrap><p "
      "class=ah>Admin Key "
      "(optional)</p><input class=li id=ak type=password placeholder='Admin "
      "key' maxlength=32 autocomplete=off></div>"
      "<button class=lb id=jb>INITIALIZE UPLINK</button>"
      "<div class=le id=le></div><div class=gps-p id=gs>"
      "<span class=gps-dot></span>Acquiring Satellites...</div></div></div>"));
  server.sendContent(
      F("<div id=C><div class=hd><div "
        "class=sg><i></i><i></i><i></i><i></i></div><h1>LoRa "
        "WAN</h1><span class='bg bf'>433MHz</span><span class='bg "
        "be'>\xF0\x9F\x94\x92 AES</span>"));
  if (TEST_MODE)
    server.sendContent(F("<span class='bg bt'>\xF0\x9F\xA7\xAA TEST</span>"));
  server.sendContent(
      F("<span class='bg bn' id=nn>-</span><span class=bu "
        "id=ub></span><span class=lo id=lo>LOGOUT</span></div>"));
  server.sendContent(F(
      "<div class=ub><span class=ul>ONLINE:</span><span id=ul></span></div>"));
  server.sendContent(
      F("<div class=tb><div class='tt on' id=tg "
        "onclick='st(\"g\")'>GROUP</div><div class=tt id=td "
        "onclick='st(\"d\")'>DM</div><select class=ds id=ds "
        "style=display:none onchange='sd(this.value)'><option "
        "value=''>select...</option></select><div class=tt id=ti "
        "onclick='st(\"i\")'>INFO</div></div>"));
  server.sendContent(F("<div id=cw></div><div id=inf></div>"));
  server.sendContent(
      F("<div id=ib><input id=mi placeholder='Type a message...' maxlength=180 "
        "autocomplete=off><span class=ib-btn id=gb title='Share "
        "Location'>\xF0\x9F\x93\x8D</span><button class=ss "
        "id=so>\xF0\x9F\x86\x98</button><button "
        "id=sb>SEND</button></div></div>"));
  server.sendContent(
      F("<div id=ao onclick='ta()'></div><div id=ap><div class=as><div "
        "class=at><span>\xE2\x9A\xA1 ADMIN</span><span style=cursor:pointer "
        "onclick='ta()'>\xE2\x9C\x95</span></div></div>"));
  server.sendContent(
      F("<div class=as><div class=at>DASHBOARD</div><div class=ac "
        "id=ad></div></div>"));
  server.sendContent(
      F("<div class=as><div class=at>USERS</div><div id=aul></div></div>"));
  server.sendContent(
      F("<div class=as><div class=at>BROADCAST</div><div class=ac><div "
        "class=ap-b><span class='ap-p on' "
        "onclick='spr(this,\"info\")'>Info</span><span class=ap-p "
        "onclick='spr(this,\"warn\")'>Warn</span><span class=ap-p "
        "onclick='spr(this,\"alert\")'>Alert</span></div><input class=ai id=bi "
        "placeholder='Broadcast...'><button class='ap-s ap-sg' "
        "onclick='bc()'>SEND</button></div></div>"));
  server.sendContent(
      F("<div class=as><div class=at>NETWORK</div><div class=ac><button "
        "class='ap-s ap-sy' onclick='pg()'>PING LoRa</button><div id=pr "
        "style='font-family:monospace;font-size:9px;color:var(--t2);margin-top:"
        "6px'></div></div></div>"));
  // FIXED: This was the line that caused the final "expected ';' before ')'"
  // error
  server.sendContent(
      F("<div class=as><div class=at>ACTIONS</div><button class='ap-s ap-sr' "
        "onclick='cc()'>CLEAR CHAT</button>"
        "<button class='ap-s ap-sy' style='margin-top:6px' "
        "onclick='sf()'>\xF0\x9F\x93\xA1 SIGNAL FINDER</button>"
        "<button class='ap-s ap-sr' style='margin-top:6px' "
        "onclick='rn()'>\xE2\x9A\xA0\xEF\xB8\x8F RESTART "
        "NODE</button></div></div>"));
  server.sendContent(
      F("<div id=fp><div "
        "style='display:flex;justify-content:space-between;align-items:"
        "center'><span "
        "style='color:var(--ac);font-size:11px;font-weight:600;letter-"
        "spacing:1px'>\xF0\x9F\x93\xA1 SIGNAL FINDER</span><span "
        "style='cursor:pointer;font-size:14px' "
        "onclick='sfs()'>\xE2\x9C\x95</span></div><div "
        "class=fb><i></i><i></i><i></i><i></i></div><div id=fr "
        "style='font-size:10px;color:var(--t2)'>Idle</div><button "
        "class='ap-s ap-sg' style='margin-top:8px' id=fsb "
        "onclick='fst()'>START</button></div>"));
  server.sendContent(
      F("<div id=sa><div class=sac><div "
        "style='font-size:32px'>\xF0\x9F\x9A\xA8</div><h2>SOS ALERT</h2><div "
        "class=sd id=sad></div><button class=sa-btn "
        "onclick='dsa()'>ACKNOWLEDGE</button></div></div>"));
  server.sendContent(F("<script>"));
  server.sendContent(F("var "
                       "cw=document.getElementById('cw'),mi=document."
                       "getElementById('mi'),sb="
                       "document.getElementById('sb'),n=0,U='',UID='',ADM="
                       "false,tab='g',dmt='',"
                       "onl=[],pt=null,bpr='info';"));
  server.sendContent(
      F("var gpsLat=null,gpsLng=null,gpsAcc=null,gpsWatch=null;"));
  server.sendContent(F(
      "function initGPS(){var "
      "gs=document.getElementById('gs');if(!navigator.geolocation){gs."
      "innerHTML='<span class=\"gps-dot\" "
      "style=\"background:var(--rd);box-shadow:none\"></span>GPS not "
      "supported. <button onclick=manGPS() "
      "style=\"color:var(--ac);background:none;border:1px solid "
      "rgba(91,163,255,.3);"
      "border-radius:6px;padding:4px "
      "8px;cursor:pointer;font-size:10px;font-family:var(--mono)\">"
      "Enter "
      "manually</"
      "button>';return;}navigator.geolocation.getCurrentPosition(function(p){"
      "gpsOK("
      "p)},"
      "function(e){if(e.code===1){gs.innerHTML='<span class=\"gps-dot\" "
      "style=\"background:var(--rd);box-shadow:none\"></span>GPS blocked "
      "(HTTP). <b>Enable:</b> <a "
      "href=\"chrome://flags/#unsafely-treat-insecure-origin-as-secure\" "
      "style=\"color:var(--ac)\">chrome://flags</a> "
      "<button onclick=manGPS() "
      "style=\"color:var(--ac);background:none;border:1px solid "
      "rgba(91,163,255,.3);"
      "border-radius:6px;padding:4px "
      "8px;cursor:pointer;font-size:10px;margin-left:8px;font-family:var(--"
      "mono)\">"
      "Manual</button>'}else{gs.innerHTML='<span class=\"gps-dot\" "
      "style=\"background:var(--rd);box-shadow:none\"></span>GPS error <button "
      "onclick=manGPS() style=\"color:var(--ac);background:none;border:1px "
      "solid rgba(91,163,255,.3);"
      "border-radius:6px;padding:4px "
      "8px;cursor:pointer;font-size:10px;margin-left:8px;font-family:var(--"
      "mono)\">"
      "Manual</button>'}},{enableHighAccuracy:true,timeout:10000});}"));
  server.sendContent(
      F("function "
        "gpsOK(p){gpsLat=p.coords.latitude;gpsLng=p.coords.longitude;gpsAcc="
        "Math."
        "round(p.coords.accuracy);var "
        "gs=document.getElementById('gs');if(gs){gs.className='gps-p "
        "ok';gs.innerHTML='<span class=gps-dot></span>GPS Active: '+"
        "gpsLat.toFixed(4)+', '+gpsLng.toFixed(4)+' "
        "(\\u00B1'+gpsAcc+'m)';}gpsWatch=navigator.geolocation.watchPosition("
        "function(p2){gpsLat=p2.coords.latitude;gpsLng=p2.coords.longitude;"
        "gpsAcc=Math.round(p2.coords.accuracy)},function(){},{"
        "enableHighAccuracy:"
        "true,maximumAge:10000})}"));
  server.sendContent(
      F("function manGPS(){var lat=prompt('Enter Latitude (e.g. "
        "17.3850):');if(!lat)return;var lng=prompt('Enter Longitude (e.g. "
        "78.4866):');if(!lng)return;gpsLat=parseFloat(lat);gpsLng="
        "parseFloat("
        "lng);gpsAcc=0;if(isNaN(gpsLat)||isNaN(gpsLng)){alert('Invalid "
        "coordinates');gpsLat=null;gpsLng=null;return;}var "
        "gs=document.getElementById('gs');if(gs){gs.className='gps-p "
        "ok';gs.innerHTML='<span class=gps-dot></span>GPS (Manual): '+"
        "gpsLat.toFixed(4)+', '+gpsLng.toFixed(4);}toast('GPS "
        "coordinates set')}"));
  server.sendContent(F("initGPS();"));
  server.sendContent(
      F("function dj(){var "
        "v=document.getElementById('un').value.trim(),k=document."
        "getElementById('"
        "ak').value.trim();if(!v){document.getElementById('le').textContent='"
        "Enter a "
        "name';return;}fetch('/"
        "join',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'name='+encodeURIComponent(v)+'&key='+"
        "encodeURIComponent(k)}).then(function(r){return "
        "r.json()}).then(function(d){if(d.error){document.getElementById('le'"
        ")."
        "textContent=d.error;return;}U=v;UID=d.uid;ADM=d.admin;localStorage."
        "setItem('lu',v);localStorage.setItem('li',d.uid);localStorage."
        "setItem('"
        "la',ADM?'1':'0');sw()}).catch(function(){document.getElementById('"
        "le')."
        "textContent='Connection error'});}"));
  server.sendContent(
      F("document.getElementById('jb').onclick=dj;document.getElementById('"
        "un')."
        "onkeydown=function(e){if(e.key==='Enter')dj()};document."
        "getElementById('"
        "ak').onkeydown=function(e){if(e.key==='Enter')dj()};"));
  server.sendContent(
      F("document.getElementById('lo').onclick=function(){U='';UID='';ADM="
        "false;"
        "localStorage.clear();if(gpsWatch)navigator.geolocation.clearWatch("
        "gpsWatch);location.reload()};"));
  server.sendContent(
      F("function "
        "sw(){document.getElementById('L').style.display='none';"
        "document.getElementById('C').style.display='flex';"
        "document.getElementById('ub').textContent=U+(ADM?' "
        "\\u26A1':'');gi();pl();if(pt)clearInterval(pt);"
        "const ws = new WebSocket('ws://' + location.hostname + ':81');"
        "ws.onmessage = function(event) {"
        "    const data = JSON.parse(event.data);"
        "    if (data.type === 'chat') {"
        "        if (typeof showMessage === 'function') showMessage(data);"
        "        else { am(data); n++; ft(); }"
        "    }"
        "};"
        "mi.focus();}"));
  server.sendContent(
      F("var "
        "su=localStorage.getItem('lu'),si=localStorage.getItem('li');if(su&&"
        "si){"
        "fetch('/join',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'name='+encodeURIComponent(su)+'&key='})"
        ".then(function(r){return r.json()}).then(function(d){if(d.error){"
        "localStorage.clear();return;}U=su;UID=d.uid;ADM=d.admin;localStorage"
        ".setItem('li',d.uid);localStorage.setItem('la',ADM?'1':'0');sw()})"
        ".catch(function(){localStorage.clear()})}"));
  server.sendContent(
      F("function "
        "st(t){tab=t;document.getElementById('tg').className='tt'+(t==='g'?' "
        "on':'');document.getElementById('td').className='tt'+(t==='d'?' "
        "on':'');document.getElementById('ti').className='tt'+(t==='i'?' "
        "on':'');document.getElementById('ds').style.display=t==='d'?'inline-"
        "block':'none';"
        "cw.style.display=(t==='i')?'none':'flex';"
        "document.getElementById('inf').style.display=t==='i'?'block':'none';"
        "document.getElementById('ib').style.display=(t==='i')?'none':'flex';"
        "if(t==='i')li();"
        "ft();}"));
  server.sendContent(F("function sd(v){dmt=v;ft();}"));
  server.sendContent(
      F("function ft(){var "
        "rs=cw.querySelectorAll('.rw,.sy');rs.forEach(function(r){var "
        "tg=r.dataset.tgt||'',sn=r.dataset.snd||'',ch=r.dataset.ch||'',pr=r."
        "dataset.prio||'',v=false;if(pr==='sos'){v=true}else "
        "if(tab==='g'){v=tg===''||tg==='*'||ch==='system'}else "
        "if(tab==='d'){if(!dmt)v=tg!==''&&tg!=='*'&&ch!=='system'&&(sn===UID||"
        "tg=="
        "=UID);else "
        "v=(sn===UID&&tg===dmt)||(sn===dmt&&tg===UID)||(r.dataset.suid===dmt&"
        "&tg=="
        "=UID)||(r.dataset.suid===UID&&tg===dmt)}r.style.display=v?'':'none'"
        "});"
        "cw.scrollTop=cw.scrollHeight;}"));
  server.sendContent(
      F("function am(m){var "
        "me=m.suid===UID,rw=document.createElement('div'),cl='rw "
        "'+(me?'ow':'ot');if(m.target&&m.target!=='*'&&m.target!=='')cl+=' "
        "dm';if(m.target==='*')cl+=' bc';if(m.prio==='sos')cl+=' "
        "sos';rw.className=cl;rw.dataset.tgt=m.target||'';rw.dataset.snd=m."
        "suid||"
        "'';rw.dataset.suid=m.suid||'';rw.dataset.ch=m.channel||'';rw."
        "dataset."
        "prio=m.prio||'';"));
  server.sendContent(
      F("var mt=document.createElement('div');mt.className='mt';var "
        "ico=m.channel==='lora'?'\\u{1F4E1}':'\\u{1F4F6}';if(m.prio==='sos')"
        "ico='"
        "\\u{1F6A8}';else if(m.target==='*')ico='\\u{1F4E3}';else "
        "if(m.target&&m.target!=='')ico='\\u{1F4AC}';var "
        "lb=me?'You':m.sender;if(m.suid)lb+=' "
        "['+m.suid+']';if(m.target&&m.target!==''&&m.target!=='*'){var "
        "tn=m.target;onl.forEach(function(x){if(x.uid===m.target)tn=x.name});"
        "lb+="
        "' \\u2192 '+tn}"));
  server.sendContent(
      F("mt.innerHTML='<span style=\"font-size:10px\">'+ico+'</span> "
        "'+lb+'&nbsp;\\u00B7&nbsp;'+m.time;rw.appendChild(mt);"));
  server.sendContent(F(
      "var bb=document.createElement('div');bb.className='bb';var "
      "tx=m.text;var "
      "gm=tx.match(/(?:\\u{1F4CD}\\s*)?GPS:\\s*([\\-\\d.]+)\\s*,\\s*([\\-\\d.]+)/i);if(gm){var "
      "lt=gm[1],lg=gm[2];var "
      "parts=tx.substring(0,gm.index||0);bb.innerHTML=parts.replace(/"
      "@(\\w+)/"
      "g,'<span class=mn>@$1</span>');var "
      "lc=document.createElement('div');lc.className='loc';lc.innerHTML='"
      "\\u{"
      "1F4CD} <span class=coords>'+lt+', '+lg+'</span>"
      "<a href=\"https://maps.google.com/maps?q='+lt+','+lg+'\" target=_blank "
      "style=\"margin-left:auto;font-size:9px;color:var(--ac);text-decoration:"
      "none;"
      "border:1px solid rgba(91,163,255,.2);padding:3px "
      "8px;border-radius:8px\">MAP</a>"
      "<span class=cp "
      "onclick=\"navigator.clipboard.writeText(\\''+lt+','+lg+'\\')\">COPY<"
      "/"
      "span>';bb.appendChild(lc)}else{tx=tx.replace(/@(\\w+)/g,'<span "
      "class=mn>@$1</span>');bb.innerHTML=tx}rw.appendChild(bb);"));
  server.sendContent(
      F("if(m.channel==='lora'&&m.rssi){var "
        "ri=document.createElement('div');ri.className='ri';ri."
        "textContent='RSSI '+m.rssi+' "
        "dBm';rw.appendChild(ri)}cw.appendChild(rw);ft();cw."
        "scrollTop=cw.scrollHeight;if(m.prio==='sos'&&!me){toast('"
        "\\u{1F6A8} SOS from '+m.sender);showSOS(m.sender,m.text)}}"));
  server.sendContent(F("function addS(t){var "
                       "e=document.createElement('div');e.className='sy';e."
                       "dataset.ch='system';"
                       "e.dataset.tgt='';e.dataset.snd='';e.textContent=t;cw."
                       "appendChild(e);ft()"
                       ";cw.scrollTop=cw.scrollHeight}"));
  server.sendContent(
      F("function toast(t){var "
        "d=document.createElement('div');d.className='toast';d.textContent=t;"
        "document.body.appendChild(d);setTimeout(function(){d.remove()},3500)"
        "}"));
  server.sendContent(
      F("function gi(){fetch('/info').then(function(r){return "
        "r.json()}).then(function(d){document.getElementById('"
        "nn').textContent=d.node;"
        "var lnd=document.getElementById('l-nd');if(lnd)lnd.textContent=d.node;"
        "addS('Radio online \\u2022 '+d.node+(d.test?' "
        "\\u2022 TEST MODE':' "
        "\\u2022 AES ENCRYPTED'))}).catch(function(){})}"));
  server.sendContent(
      F("function li(){fetch('/info').then(function(r){return "
        "r.json()}).then(function(d){fetch('/stats').then(function(r){return "
        "r.json()}).then(function(s){var h='<div class=ic><h3>\\u{1F4E1} "
        "Radio</h3>';h+='<div class=ir><span class=ik>Node</span><span "
        "class=iv>'+d.node+'</span></div>';h+='<div class=ir><span "
        "class=ik>Frequency</span><span "
        "class=iv>'+d.freq+'</span></div>';h+='<div class=ir><span "
        "class=ik>Encryption</span><span "
        "class=iv>AES-128</span></div>';h+='<div "
        "class=ir><span class=ik>SF/BW/CR</span><span "
        "class=iv>SF'+d.sf+'/'+d.bw+'k/4:'+d.cr+'</span></div>';h+='<div "
        "class=ir><span class=ik>TX Power</span><span class=iv>'+d.pwr+' "
        "dBm</span></div>';h+='<div class=ir><span class=ik>Mode</span><span "
        "class=iv>'+(d.test?'TEST':'LIVE')+'</span></div></div>';"));
  server.sendContent(
      F("h+='<div class=ic><h3>\\u{1F4F6} Network</h3>';h+='<div "
        "class=ir><span "
        "class=ik>SSID</span><span "
        "class=iv>'+d.ssid+'</span></div>';h+='<div "
        "class=ir><span class=ik>IP</span><span "
        "class=iv>'+d.ip+'</span></div>';h+='<div class=ir><span "
        "class=ik>Users</span><span "
        "class=iv>'+s.users+'</span></div>';h+='<div "
        "class=ir><span class=ik>Messages</span><span "
        "class=iv>'+s.msgs+'</span></div>';h+='<div class=ir><span "
        "class=ik>LoRa "
        "TX/RX</span><span class=iv>'+s.tx+'/'+s.rx+'</span></div>';h+='<div "
        "class=ir><span class=ik>Heap</span><span class=iv>'+s.heap+' "
        "B</span></div>';h+='<div class=ir><span class=ik>Uptime</span><span "
        "class=iv>'+d.uptime+'</span></div></div>';"));
  server.sendContent(
      F("h+='<div class=ic><h3>\\u{1F4CD} GPS Status</h3>';h+='<div "
        "class=ir><span class=ik>Status</span><span "
        "class=iv>'+(gpsLat?'Active':'No "
        "fix')+'</span></div>';if(gpsLat){h+='<div class=ir><span "
        "class=ik>Latitude</span><span "
        "class=iv>'+gpsLat.toFixed(6)+'</span></div>';h+='<div "
        "class=ir><span "
        "class=ik>Longitude</span><span "
        "class=iv>'+gpsLng.toFixed(6)+'</span></div>';h+='<div "
        "class=ir><span "
        "class=ik>Accuracy</span><span "
        "class=iv>\\u00B1'+gpsAcc+'m</span></div>'}h+='</div>';"));
  server.sendContent(F("document.getElementById('inf').innerHTML=h})}).catch("
                       "function(){})}"));
  server.sendContent(
      F("function "
        "pl(){fetch('/"
        "messages?from='+n+'&uid='+encodeURIComponent(UID)).then("
        "function(r){return "
        "r.json()}).then(function(ms){if(ms.length>0){ms.forEach("
        "am);n+=ms.length}}).catch(function(){});"));
  server.sendContent(
      F("fetch('/users').then(function(r){return "
        "r.json()}).then(function(u){onl=u;var "
        "ul=document.getElementById('ul'),ds=document.getElementById('ds');"
        "ul."
        "innerHTML='';ds.innerHTML='<option "
        "value=\"\">select...</option>';u.forEach(function(x){var "
        "c=document.createElement('span');c.className='uc'+(x.admin?' "
        "ad':'')+(x.muted?' mt':'');c.innerHTML='<span "
        "class=dt></span>'+x.name+'<span "
        "style=\"font-size:8px;color:var(--t2)\">['+x.uid+']</"
        "span>'+(x.admin?' "
        "\\u26A1':'')+(x.muted?' "
        "\\u{1F507}':'');c.onclick=function(){st('d');document."
        "getElementById('"
        "ds').value=x.uid;sd(x.uid)};ul.appendChild(c);if(x.uid!==UID){var "
        "o=document.createElement('option');o.value=x.uid;o.textContent=x."
        "name+' "
        "['+x.uid+']';ds.appendChild(o)}});"));
  server.sendContent(
      F("if(ADM){fetch('/stats').then(function(r){return "
        "r.json()}).then(function(s){document.getElementById('ad').innerHTML="
        "'<"
        "div class=ar><span class=ak>Users</span><span "
        "class=av>'+s.users+'</span></div><div class=ar><span "
        "class=ak>Messages</span><span class=av>'+s.msgs+'</span></div><div "
        "class=ar><span class=ak>LoRa TX/RX</span><span "
        "class=av>'+s.tx+'/'+s.rx+'</span></div><div class=ar><span "
        "class=ak>Heap</span><span class=av>'+s.heap+'</span></div>';var "
        "ah='';u.forEach(function(x){ah+='<div class=au><span>'+x.name+' "
        "['+x.uid+']'+(x.admin?' \\u26A1':'')+(x.muted?' "
        "\\u{1F507}':'')+'</span><span>';if(x.uid!==UID){ah+='<span "
        "class=\"ab "
        "kr\" onclick=\"ku(\\''+x.uid+'\\')\">&times;</span><span class=\"ab "
        "mu\" "
        "onclick=\"mu(\\''+x.uid+'\\')\">M</span>'}ah+='</span></"
        "div>'});document.getElementById('aul').innerHTML=ah}).catch("
        "function(){}"
        ")}}).catch(function(){})}"));
  server.sendContent(
      F("function snd(){var t=mi.value.trim();if(!t||!UID)return;var "
        "tg='';if(tab==='d'&&dmt)tg=dmt;sb.disabled=true;mi.value='';fetch('/"
        "send',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'msg='+encodeURIComponent(t)+'&uid='+"
        "encodeURIComponent(UID)+'&target='+encodeURIComponent(tg)}).then("
        "function(r){if(!r.ok)addS('Send failed');else "
        "pl()}).catch(function(){addS('Network "
        "error')}).finally(function(){sb.disabled=false;mi.focus()})}sb."
        "onclick="
        "snd;mi.onkeydown=function(e){if(e.key==='Enter')snd()};"));
  server.sendContent(
      F("document.getElementById('gb').onclick=function(){if(!gpsLat){toast('"
        "GPS "
        "not available');initGPS();return;}var "
        "msg='\\u{1F4CD}GPS:'+gpsLat.toFixed(6)+','+gpsLng.toFixed(6)+' "
        "(\\u00B1'+gpsAcc+'m)';var "
        "tg='';if(tab==='d'&&dmt)tg=dmt;fetch('/"
        "send',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'msg='+encodeURIComponent(msg)+'&uid='+"
        "encodeURIComponent(UID)+'&target='+encodeURIComponent(tg)}).then("
        "function(){pl();toast('Location shared')})};"));
  server.sendContent(
      F("document.getElementById('so').onclick=function(){var m=prompt('SOS "
        "Emergency Message:');if(m&&m.trim()){var "
        "msg=m.trim();if(gpsLat){msg+=' "
        "\\u{1F4CD}GPS:'+gpsLat.toFixed(6)+','+gpsLng.toFixed(6)}fetch('/"
        "send',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'msg='+encodeURIComponent(msg)+'&uid='+"
        "encodeURIComponent(UID)+'&target=&prio=sos'}).then(function(){pl();"
        "toast('SOS SENT')})}};"));
  server.sendContent(
      F("function ta(){var "
        "p=document.getElementById('ap'),o=document.getElementById('ao');p."
        "classList.toggle('on');o.classList.toggle('on')}document."
        "getElementById("
        "'ub').onclick=function(){if(ADM)ta()};"));
  server.sendContent(F("function "
                       "spr(el,p){bpr=p;document.querySelectorAll('.ap-p')."
                       "forEach(function(e){"
                       "e.className='ap-p'});el.className='ap-p on'}"));
  server.sendContent(
      F("function bc(){var "
        "t=document.getElementById('bi').value.trim();if(!t)return;fetch('/"
        "send',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'msg='+encodeURIComponent(t)+'&uid='+"
        "encodeURIComponent(UID)+'&target=*&prio='+bpr}).then(function(){"
        "document.getElementById('bi').value='';pl();toast('Broadcast "
        "sent')})}"));
  server.sendContent(
      F("function ku(id){if(confirm('Kick "
        "user?'))fetch('/"
        "kick',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'uid='+UID+'&target='+id}).then("
        "function(){"
        "pl();toast('Kicked')})}"));
  server.sendContent(
      F("function "
        "mu(id){fetch('/"
        "mute',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'uid='+UID+'&target='+id}).then("
        "function(){"
        "pl();toast('Mute toggled')})}"));
  server.sendContent(
      F("function cc(){if(confirm('Clear all "
        "chat?'))fetch('/"
        "clear',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'uid='+UID}).then(function(){cw."
        "innerHTML='"
        "';n=0;toast('Cleared')})}"));
  server.sendContent(
      F("function pg(){fetch('/ping?uid='+UID).then(function(r){return "
        "r.json()}).then(function(d){document.getElementById('pr')."
        "textContent=d.test?'Sim: RSSI '+d.rssi+'dBm "
        "'+d.ms+'ms':d.status==='sent'?'Ping sent...':'Error'})}"));
  server.sendContent(
      F("var actx=null;function "
        "sosBeep(){try{if(!actx)actx=new(window.AudioContext||window."
        "webkitAudioContext)();var "
        "o=actx.createOscillator(),g=actx.createGain();o.connect(g);g."
        "connect(actx.destination);o.frequency.value=880;g.gain.value=0.3;o."
        "start();setTimeout(function(){o.stop()},500)}catch(e){}}function "
        "showSOS(s,t){var "
        "h='<b>From:</b> '+s+'<br>';var "
        "gm=t.match(/(?:\\u{1F4CD}\\s*)?GPS:\\s*([\\-\\d.]+)\\s*,\\s*([\\-\\d.]+)/i);if(gm){var "
        "lt=gm[1],lg=gm[2];var "
        "txt=t.substring(0,gm.index||0);h+=txt+'<div "
        "style=\"margin-top:8px;padding:10px;background:rgba(52,211,153,.1);"
        "border:1px solid "
        "rgba(52,211,153,.2);border-radius:10px;font-family:monospace;font-"
        "size:11px\"><span "
        "style=\"color:var(--g);font-weight:600\">\\u{1F4CD} '+lt+', "
        "'+lg+'</span><br><a "
        "href=\"https://maps.google.com/maps?q='+lt+','+lg+'\" "
        "target=_blank "
        "style=\"color:var(--ac);font-size:10px\">Open in Google "
        "Maps</a> <span "
        "onclick=\"navigator.clipboard.writeText(\\''+lt+','+lg+'\\')"
        "\" style=\"color:var(--ac);cursor:pointer;font-size:10px;margin-left:"
        "8px;border:1px solid rgba(91,163,255,.2);border-radius:6px;padding:"
        "2px 8px\">COPY</span></div>'}else{h+=t}document.getElementById('sad'"
        ").innerHTML=h;document.getElementById('sa').style.display='flex';"
        "sosBeep();if(navigator.vibrate)navigator.vibrate([200,100,200,100,"
        "200,100,200])}function "
        "dsa(){document.getElementById('sa').style.display='none'}"));
  server.sendContent(F("var fint=null;function "
                       "sf(){document.getElementById('fp').style.display='"
                       "block';ta()}function "
                       "sfs(){document.getElementById('fp').style.display='"
                       "none';if(fint){clearInterval(fint);fint=null;fetch('/"
                       "finder?uid='+UID+'&action=stop')}}"));
  server.sendContent(F("function fst(){var "
                       "b=document.getElementById('fsb');if(fint){"
                       "clearInterval(fint);fint=null;fetch('/"
                       "finder?uid='+UID+'&action=stop');b.textContent='"
                       "START';document.getElementById('fr').textContent='"
                       "Idle';document.querySelectorAll('.fb "
                       "i').forEach(function(x){x.className=''})}else{fetch('"
                       "/finder?uid='+UID+'&action=start');b.textContent='"
                       "STOP';fint=setInterval(fpoll,1500)}}"));
  server.sendContent(
      F("function fpoll(){fetch('/finder?uid='+UID).then(function(r){return "
        "r.json()}).then(function(d){var "
        "r=d.rssi,q=d.quality,bars=document.querySelectorAll('.fb "
        "i');bars.forEach(function(x){x.className=''});var "
        "n=0;if(q==='excellent')n=4;else if(q==='good')n=3;else "
        "if(q==='weak')n=2;else if(q==='very_weak')n=1;for(var "
        "i=0;i<n;i++)bars[i].className='on';var "
        "qt=q==='none'?'Searching...':'RSSI: '+r+' dBm ('+q.replace('_',' "
        "').toUpperCase()+')';document.getElementById('fr').textContent=qt})"
        "}"));
  server.sendContent(
      F("function rn(){if(confirm('Restart this node? All users will be "
        "disconnected.'))fetch('/"
        "restart',{method:'POST',headers:{'Content-Type':'application/"
        "x-www-form-urlencoded'},body:'uid='+UID}).then(function(){toast('"
        "Node restarting...')})}"));
  server.sendContent(F("</script></body></html>"));
  server.sendContent(F(""));
}
// ========== HANDLERS ==========
void handleRoot() { sendPage(); }
void handleJoin() {
  String nm = server.arg("name"), key = server.arg("key");
  if (nm.length() < 1 || nm.length() > 20) {
    server.send(400, "application/json", "{\"error\":\"Invalid name\"}");
    return;
  }
  bool adm = key.length() > 0 && key == String(ADMIN_KEY);
  int i = findUserByName(nm);
  if (i >= 0) {
    users[i].seen = millis();
    users[i].adm = adm;
    server.send(200, "application/json",
                "{\"uid\":\"" + users[i].uid +
                    "\",\"admin\":" + (adm ? "true" : "false") + "}");
    return;
  }
  if (uc >= MAX_USERS) {
    server.send(503, "application/json", "{\"error\":\"Server full\"}");
    return;
  }
  String uid = mkUid();
  users[uc] = {nm, uid, millis(), millis(), adm, false, 0};
  uc++;
  push("System", "", nm + " (" + uid + ") joined", "system");
  server.send(200, "application/json",
              "{\"uid\":\"" + uid + "\",\"admin\":" + (adm ? "true" : "false") +
                  "}");
}
void handleInfo() {
  String j = "{\"node\":\"" + String(NODE_NAME) +
             "\",\"freq\":\"433 MHz\",\"sf\":" + String(LORA_SF) +
             ",\"bw\":" + String((int)(LORA_BW / 1000)) +
             ",\"cr\":" + String(LORA_CR) + ",\"pwr\":" + String(LORA_POWER) +
             ",\"test\":" + (TEST_MODE ? "true" : "false") + ",\"uptime\":\"" +
             uptime() + "\",\"ssid\":\"" + String(AP_SSID) + "\",\"ip\":\"" +
             WiFi.softAPIP().toString() + "\"}";
  server.send(200, "application/json", j);
}
void handleUsers() {
  cleanUsers();
  String j = "[";
  for (int i = 0; i < uc; i++) {
    if (i > 0)
      j += ",";
    j += "{\"name\":\"" + je(users[i].name) + "\",\"uid\":\"" + users[i].uid +
         "\",\"admin\":" + (users[i].adm ? "true" : "false") +
         ",\"muted\":" + (users[i].muted ? "true" : "false") +
         ",\"msgs\":" + String(users[i].msgs) + "}";
  }
  j += "]";
  server.send(200, "application/json", j);
}
void handleMessages() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  if (uid.length() > 0) {
    int i = findUser(uid);
    if (i >= 0)
      users[i].seen = millis();
  }
  int from = server.hasArg("from") ? server.arg("from").toInt() : 0;
  if (from < 0)
    from = 0;
  if (from > mc)
    from = mc;
  String j = "[";
  bool first = true;
  for (int i = from; i < mc; i++) {
    if (!first)
      j += ",";
    first = false;
    j += "{\"sender\":\"" + je(chat[i].sender) + "\",\"suid\":\"" +
         je(chat[i].suid) + "\",\"text\":\"" + je(chat[i].text) +
         "\",\"time\":\"" + chat[i].time + "\",\"channel\":\"" +
         chat[i].channel + "\",\"target\":\"" + je(chat[i].target) +
         "\",\"prio\":\"" + chat[i].prio +
         "\",\"rssi\":" + String(chat[i].rssi) + "}";
  }
  j += "]";
  server.send(200, "application/json", j);
}
void handleSend() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  String msg = server.hasArg("msg") ? server.arg("msg") : "";
  String tgt = server.hasArg("target") ? server.arg("target") : "";
  String prio = server.hasArg("prio") ? server.arg("prio") : "";
  String fallbackName = server.hasArg("name") ? server.arg("name") : "";
  fallbackName.trim();
  if (!uid.length() || !msg.length()) {
    server.send(400, "text/plain", "Missing");
    return;
  }
  int ui = findUser(uid);
  if (ui < 0) {
    if (fallbackName.length() >= 1 && fallbackName.length() <= 20 && uc < MAX_USERS) {
      users[uc] = {fallbackName, uid, millis(), millis(), false, false, 0};
      ui = uc++;
      push("System", "", "Recovered session for " + fallbackName + " (" + uid + ")", "system");
    } else {
      server.send(403, "text/plain", "Not registered");
      return;
    }
  }
  users[ui].seen = millis();
  if (users[ui].muted) {
    server.send(403, "text/plain", "Muted");
    return;
  }
  if (msg.length() > MAX_MSG_LEN)
    msg = msg.substring(0, MAX_MSG_LEN);
  if (prio == "sos") {
    // Keep SOS behavior identical across web/app clients.
    tgt = "";
  }
  users[ui].msgs++;
  push(users[ui].name, uid, msg, "wifi", tgt, prio, 0);
  String pkt = "M|" + String(NODE_NAME) + "|" + uid + "|" + users[ui].name +
               "|" + tgt + "|" + prio + "|" + msg;
  if (!TEST_MODE) {
    // Track recently-transmitted chat packet to suppress same-radio self-echo.
    lastTxMsgPkt = pkt;
    lastTxMsgAt = millis();
    sendLoRa(pkt, true);
  } else {
    echoPend = true;
    echoT = millis() + 2000;
    echoU = users[ui].name;
    echoUid = uid;
    echoTx = msg;
    echoTg = tgt;
  }
  server.send(200, "text/plain", "OK");
}
void handleKick() {
  String uid = server.arg("uid"), tgt = server.arg("target");
  if (!isAdm(uid)) {
    server.send(403, "text/plain", "Not admin");
    return;
  }
  int i = findUser(tgt);
  if (i < 0) {
    server.send(404, "text/plain", "Not found");
    return;
  }
  push("Admin", "", users[i].name + " kicked", "system");
  for (int j = i; j < uc - 1; j++) {
    users[j] = users[j + 1];
    helperLat[j] = helperLat[j + 1];
    helperLon[j] = helperLon[j + 1];
    helperGPS[j] = helperGPS[j + 1];
  }
  helperLat[uc - 1] = 0;
  helperLon[uc - 1] = 0;
  helperGPS[uc - 1] = false;
  uc--;
  server.send(200, "text/plain", "OK");
}
void handleMute() {
  String uid = server.arg("uid"), tgt = server.arg("target");
  if (!isAdm(uid)) {
    server.send(403, "text/plain", "Not admin");
    return;
  }
  int i = findUser(tgt);
  if (i < 0) {
    server.send(404, "text/plain", "Not found");
    return;
  }
  users[i].muted = !users[i].muted;
  push("Admin", "", users[i].name + (users[i].muted ? " muted" : " unmuted"),
       "system");
  server.send(200, "application/json",
              String("{\"muted\":") + (users[i].muted ? "true}" : "false}"));
}
void handleClear() {
  String uid = server.arg("uid");
  if (!isAdm(uid)) {
    server.send(403, "text/plain", "Not admin");
    return;
  }
  mc = 0;
  push("Admin", "", "Chat cleared", "system");
  server.send(200, "text/plain", "OK");
}
void handlePing() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  if (uid.length() > 0) {
    int i = findUser(uid);
    if (i >= 0) {
      users[i].seen = millis();
    }
  }
  if (TEST_MODE) {
    server.send(200, "application/json",
                "{\"rssi\":-42,\"ms\":150,\"test\":true}");
    return;
  }
  bool sent = false;
  if (millis() - lastPingTx >= LORA_PING_GAP_MS && txQCount == 0) {
    String pkt = "P|" + String(NODE_NAME);
    sendLoRa(pkt);
    lastPingTx = millis();
    sent = true;
  }
  String j = "{\"status\":\"" + String(sent ? "sent" : "throttled") + "\",\"rssi\":" + String(lastRSSI) + "}";
  server.send(200, "application/json", j);
}
void handleStats() {
  String j = "{\"users\":" + String(uc) + ",\"msgs\":" + String(mc) +
             ",\"tx\":" + String(st.tx) + ",\"rx\":" + String(st.rx) +
             ",\"heap\":" + String(ESP.getFreeHeap()) + "}";
  server.send(200, "application/json", j);
}
void handleGPS() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  String lat = server.hasArg("lat") ? server.arg("lat") : "";
  String lon = server.hasArg("lon") ? server.arg("lon") : "";
  String fallbackName = server.hasArg("name") ? server.arg("name") : "";
  fallbackName.trim();
  if (!uid.length() || !lat.length() || !lon.length()) {
    server.send(400, "text/plain", "Missing params");
    return;
  }
  int i = findUser(uid);
  if (i < 0) {
    if (fallbackName.length() >= 1 && fallbackName.length() <= 20 && uc < MAX_USERS) {
      users[uc] = {fallbackName, uid, millis(), millis(), false, false, 0};
      i = uc++;
      push("System", "", "Recovered GPS session for " + fallbackName + " (" + uid + ")", "system");
    } else {
      server.send(403, "text/plain", "Not registered");
      return;
    }
  }
  users[i].seen = millis();
  helperLat[i] = lat.toFloat();
  helperLon[i] = lon.toFloat();
  helperGPS[i] = true;
  String pkt = "LOC|" + uid + "|" + String(helperLat[i], 6) + "|" +
               String(helperLon[i], 6);
  if (!TEST_MODE)
    sendLoRa(pkt);

  String json = "{";
  json += "\"type\":\"gps\",";
  json += "\"uid\":\"" + users[i].uid + "\",";
  json += "\"lat\":" + String(helperLat[i], 6) + ",";
  json += "\"lng\":" + String(helperLon[i], 6);
  json += "}";
  webSocket.broadcastTXT(json);

  if (users[i].adm || nodeLat == 0.0) {
    nodeLat = helperLat[i];
    nodeLon = helperLon[i];
    String nodePkt = "LOC|" + String(NODE_NAME) + "|" + String(nodeLat, 6) + "|" + String(nodeLon, 6);
    if (!TEST_MODE) sendLoRa(nodePkt);
    String nodeJson = "{";
    nodeJson += "\"type\":\"gps\",";
    nodeJson += "\"uid\":\"" + String(NODE_NAME) + "\",";
    nodeJson += "\"name\":\"" + String(NODE_NAME) + "\",";
    nodeJson += "\"lat\":" + String(nodeLat, 6) + ",";
    nodeJson += "\"lng\":" + String(nodeLon, 6);
    nodeJson += "}";
    webSocket.broadcastTXT(nodeJson);
  }

  server.send(200, "application/json", "{\"ok\":true}");
}
void handleFinder() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  String action = server.hasArg("action") ? server.arg("action") : "status";
  if (!isAdm(uid) && action != "status") {
    server.send(403, "text/plain", "Not admin");
    return;
  }
  if (action == "start") {
    finderActive = true;
    finderRSSI = 0;
    finderLastPing = 0;
    finderTarget = server.hasArg("target") ? server.arg("target") : "";
  } else if (action == "stop") {
    finderActive = false;
  }
  String q = "";
  if (finderRSSI == 0)
    q = "none";
  else if (finderRSSI > -80)
    q = "excellent";
  else if (finderRSSI > -95)
    q = "good";
  else if (finderRSSI > -110)
    q = "weak";
  else
    q = "very_weak";
  server.send(200, "application/json",
              "{\"active\":" + String(finderActive ? "true" : "false") +
                  ",\"rssi\":" + String(finderRSSI) + ",\"quality\":\"" + q +
                  "\",\"target\":\"" + finderTarget + "\"}");
}
void handleRestart() {
  String uid = server.arg("uid");
  if (!isAdm(uid)) {
    server.send(403, "text/plain", "Not admin");
    return;
  }
  push("Admin", "", "Node restarting...", "system");
  server.send(200, "text/plain", "Restarting");
  delay(500);
  ESP.restart();
}
void handleSession() {
  String uid = server.hasArg("uid") ? server.arg("uid") : "";
  int i = findUser(uid);
  if (i >= 0) {
    users[i].seen = millis();
    server.send(200, "application/json", "{\"valid\":true}");
  } else {
    server.send(200, "application/json", "{\"valid\":false}");
  }
}
void handleAllGPS() {
  String j = "[";
  for (int i = 0; i < uc; i++) {
    if (i > 0) j += ",";
    j += "{\"uid\":\"" + users[i].uid + "\",\"name\":\"" + je(users[i].name) +
         "\",\"lat\":" + String(helperLat[i], 6) +
         ",\"lng\":" + String(helperLon[i], 6) +
         ",\"hasGPS\":" + (helperGPS[i] ? "true" : "false") + "}";
  }
  if (nodeLat != 0.0) {
    if (uc > 0) j += ",";
    j += "{\"uid\":\"" + String(NODE_NAME) + "\",\"name\":\"" + String(NODE_NAME) +
         "\",\"lat\":" + String(nodeLat, 6) + ",\"lng\":" + String(nodeLon, 6) + ",\"hasGPS\":true}";
  }
  j += "]";
  server.send(200, "application/json", j);
}
void handleStart() {
  const char *page = R"rawliteral(
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LoRaChat Launch</title>
  <style>
    body{margin:0;background:#06090f;color:#e2e8f0;font-family:monospace}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{width:100%;max-width:360px;background:rgba(12,16,24,.95);border:1px solid #1e2d42;border-radius:18px;padding:20px}
    h1{margin:0 0 8px;font-size:18px;color:#5ba3ff;letter-spacing:1px}
    p{margin:0 0 14px;color:#94a3b8;font-size:12px;line-height:1.5}
    .btn{display:block;width:100%;text-align:center;padding:12px 10px;border-radius:12px;border:1px solid #1e2d42;color:#e2e8f0;text-decoration:none;margin-top:10px;font-weight:700;letter-spacing:.5px}
    .app{background:linear-gradient(135deg,#5ba3ff,#3d8bef);border-color:transparent;color:#fff}
    .web{background:rgba(15,23,36,.9)}
    .exit{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.4);color:#fecaca}
    .fail{display:none;margin-top:12px;padding:10px;border-radius:10px;border:1px solid rgba(251,191,36,.35);background:rgba(80,60,20,.25);color:#fcd34d;font-size:11px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>LoRa Chat</h1>
      <p>Choose where to continue. If app is not installed, use web chat.</p>
      <a class="btn app" href="#" onclick="openApp();return false;">OPEN APP</a>
      <a class="btn web" href="/web">CONTINUE ON WEB</a>
      <a class="btn exit" href="#" onclick="exitPage();return false;">EXIT</a>
      <div id="fail" class="fail">
        App not installed or did not open.
        <a style="color:#93c5fd" href="#" onclick="openApp();return false;">Retry</a>
        or
        <a style="color:#93c5fd" href="/web">Continue on Web</a>
      </div>
    </div>
  </div>
  <script>
    function openApp(){
      var fail=document.getElementById('fail');
      fail.style.display='none';
      var done=false;
      var t=setTimeout(function(){
        if(!document.hidden && !done){
          fail.style.display='block';
        }
      },1600);
      document.addEventListener('visibilitychange',function(){
        if(document.hidden){
          done=true;
          clearTimeout(t);
        }
      },{once:true});
      window.location.href='lorachatapp://';
    }
    function exitPage(){
      window.close();
      setTimeout(function(){location.href='about:blank';},300);
    }
  </script>
</body>
</html>
)rawliteral";
  server.send(200, "text/html", page);
}
void handleCaptivePortal() {
  String loc = "http://" + WiFi.softAPIP().toString() + "/start";
  server.sendHeader("Location", loc, true);
  server.send(302, "text/plain", "");
}
void handle404() { server.send(404, "text/plain", "Not found"); }
// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n======= ESP32 LoRa WAN Chat v5.0 ======="));
  Serial.printf("Node:%s SSID:%s Mode:%s\n", NODE_NAME, AP_SSID,
                TEST_MODE ? "TEST" : "LIVE");
  Serial.println(F("Pins: NSS=D5 RST=D14 DIO0=D4 SCK=D18 MISO=D19 MOSI=D23"));
  Serial.println(F("GPS: Browser Geolocation API (phone permission)"));
  Serial.println(F("========================================="));
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  if (!TEST_MODE) {
    SPI.begin(18, 19, 23, LORA_SS);
    LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
    Serial.print("[LoRa]Init...");
    if (!LoRa.begin(LORA_FREQ)) {
      Serial.println("FAIL!");
      while (1) {
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
        delay(100);
      }
    }
    LoRa.setTxPower(LORA_POWER);
    LoRa.setSignalBandwidth(LORA_BW);
    LoRa.setSpreadingFactor(LORA_SF);
    LoRa.setCodingRate4(LORA_CR);
    LoRa.enableCrc();
    LoRa.setSyncWord(0x12);     // Sync word for reliable detection
    LoRa.setPreambleLength(12); // Longer preamble = better sensitivity
    LoRa.setGain(0);            // Auto LNA gain (max sensitivity)
    Serial.println("OK");
  } else
    Serial.println("[TEST]LoRa skipped");
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS, 1, 0, 8);
  delay(500);
  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
  Serial.print("[WiFi]IP:");
  Serial.println(WiFi.softAPIP());
  server.on("/", HTTP_GET, handleStart);
  server.on("/web", HTTP_GET, handleRoot);
  server.on("/start", HTTP_GET, handleStart);
  server.on("/join", HTTP_POST, handleJoin);
  server.on("/info", HTTP_GET, handleInfo);
  server.on("/users", HTTP_GET, handleUsers);
  server.on("/messages", HTTP_GET, handleMessages);
  server.on("/send", HTTP_POST, handleSend);
  server.on("/kick", HTTP_POST, handleKick);
  server.on("/mute", HTTP_POST, handleMute);
  server.on("/clear", HTTP_POST, handleClear);
  server.on("/ping", HTTP_GET, handlePing);
  server.on("/stats", HTTP_GET, handleStats);
  server.on("/gps", HTTP_POST, handleGPS);
  server.on("/finder", HTTP_GET, handleFinder);
  server.on("/restart", HTTP_POST, handleRestart);
  server.on("/session", HTTP_GET, handleSession);
  server.on("/allgps", HTTP_GET, handleAllGPS);
  // Captive portal detection endpoints used by Android/iOS/Windows
  server.on("/generate_204", HTTP_ANY, handleCaptivePortal);
  server.on("/gen_204", HTTP_ANY, handleCaptivePortal);
  server.on("/hotspot-detect.html", HTTP_ANY, handleCaptivePortal);
  server.on("/library/test/success.html", HTTP_ANY, handleCaptivePortal);
  server.on("/connecttest.txt", HTTP_ANY, handleCaptivePortal);
  server.on("/ncsi.txt", HTTP_ANY, handleCaptivePortal);
  server.on("/redirect", HTTP_ANY, handleCaptivePortal);
  server.on("/canonical.html", HTTP_ANY, handleCaptivePortal);
  server.onNotFound(handleCaptivePortal);
  server.begin();
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("[Web]http://192.168.4.1\n");
  push("System", "",
       String(NODE_NAME) + " online" + (TEST_MODE ? " (test)" : " (encrypted)"),
       "system");
}
// ========== LOOP ==========
void loop() {
  dnsServer.processNextRequest();
  server.handleClient();
  webSocket.loop();
  processLoRaTxQueue();
  if (!TEST_MODE) {
    int ps = LoRa.parsePacket();
    if (ps > 0 && ps <= 250) {
      uint8_t *rx = (uint8_t *)malloc(ps);
      if (rx) {
        int idx = 0;
        while (LoRa.available() && idx < ps)
          rx[idx++] = (uint8_t)LoRa.read();
        int rssi = LoRa.packetRssi();
        String pl = decAES(rx, idx);
        free(rx);
        if (pl.length() > 0) {
          st.rx++;
          if (pl.startsWith("M|")) {
            int s1 = pl.indexOf('|'), s2 = pl.indexOf('|', s1 + 1),
                s3 = pl.indexOf('|', s2 + 1), s4 = pl.indexOf('|', s3 + 1),
                s5 = pl.indexOf('|', s4 + 1), s6 = pl.indexOf('|', s5 + 1);
            if (s6 > 0) {
              String nd = pl.substring(s1 + 1, s2),
                     uid = pl.substring(s2 + 1, s3),
                     sndrName = pl.substring(s3 + 1, s4),
                     tg = pl.substring(s4 + 1, s5),
                     pr = pl.substring(s5 + 1, s6), tx = pl.substring(s6 + 1);
              bool likelySelfEcho = false;
              if (pl == lastTxMsgPkt && (millis() - lastTxMsgAt) <= 3000) {
                likelySelfEcho = true;
              }
              if (!likelySelfEcho) {
                int ui = findUser(uid);
                // Preserve original sender and target from packet so broadcast/DM
                // routing stays identical across node web/app clients.
                String nm = ui >= 0 ? users[ui].name : sndrName;
                push(nm, uid, tx, "lora", tg, pr, rssi);
              }
            }
          } else if (pl.startsWith("P|")) {
            String nd = pl.substring(2);
            if (nd != String(NODE_NAME)) {
              String pkt = "O|" + String(NODE_NAME) + "|" + String(rssi);
              sendLoRa(pkt);
            }
          } else if (pl.startsWith("O|")) {
            st.prssi = rssi;
            if (finderActive)
              finderRSSI = rssi;
            lastRSSI = rssi;
            Serial.printf("[Ping]Pong RSSI:%d\n", rssi);
          } else if (pl.startsWith("LOC|")) {
            int l1 = pl.indexOf('|'), l2 = pl.indexOf('|', l1 + 1),
                l3 = pl.indexOf('|', l2 + 1);
            if (l3 > 0) {
              String luid = pl.substring(l1 + 1, l2);
              String lt = pl.substring(l2 + 1, l3);
              String lg = pl.substring(l3 + 1);
              int ui = findUser(luid);
              String nm = ui >= 0 ? users[ui].name : luid;
              // Broadcast LoRa-received GPS to WebSocket clients
              String gpsJson = "{";
              gpsJson += "\"type\":\"gps\",";
              gpsJson += "\"uid\":\"" + luid + "\",";
              gpsJson += "\"name\":\"" + je(nm) + "\",";
              gpsJson += "\"lat\":" + lt + ",";
              gpsJson += "\"lng\":" + lg;
              gpsJson += "}";
              webSocket.broadcastTXT(gpsJson);
            }
          }
        } else
          Serial.println("[LoRa]Decrypt fail");
      }
    }
  }
  if (TEST_MODE && echoPend && millis() >= echoT) {
    echoPend = false;
    String rn = (String(NODE_NAME) == "Node-A") ? "Node-B" : "Node-A";
    push("EchoBot@" + rn, "E00", echoTx, "lora",
         echoTg.length() > 0 ? echoUid : "", "", -42);
  }
  if (finderActive && millis() - finderLastPing > 2000) {
    finderLastPing = millis();
    if (!TEST_MODE) {
      String pkt = "P|" + String(NODE_NAME);
      sendLoRa(pkt);
    } else {
      finderRSSI = -60 - (int)random(0, 50);
      lastRSSI = finderRSSI;
    }
  }
  static unsigned long lc = 0;
  if (millis() - lc > LORA_NODE_LOC_INTERVAL_MS) {
    lc = millis();
    cleanUsers();
    if (nodeLat != 0.0 && txQCount < (LORA_TX_QUEUE_MAX / 2)) {
      String nodePkt = "LOC|" + String(NODE_NAME) + "|" + String(nodeLat, 6) + "|" + String(nodeLon, 6);
      if (!TEST_MODE) sendLoRa(nodePkt);
      String nodeJson = "{";
      nodeJson += "\"type\":\"gps\",";
      nodeJson += "\"uid\":\"" + String(NODE_NAME) + "\",";
      nodeJson += "\"name\":\"" + String(NODE_NAME) + "\",";
      nodeJson += "\"lat\":" + String(nodeLat, 6) + ",";
      nodeJson += "\"lng\":" + String(nodeLon, 6);
      nodeJson += "}";
      webSocket.broadcastTXT(nodeJson);
    }
  }
  delay(1);
}
