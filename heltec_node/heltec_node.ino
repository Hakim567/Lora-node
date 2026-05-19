// Turns the 'PRG' button into the power button, long press is off 
#define HELTEC_POWER_BUTTON   // must be before "#include <heltec_unofficial.h>"

// Uncomment this if you have Wireless Stick v3
// #define HELTEC_WIRELESS_STICK

// creates 'radio', 'display' and 'button' instances 
#include <heltec_unofficial.h>

// LoRaWAN setup
const LoRaWANBand_t Region = AS923;
//const uint8_t subBand = 1; // For US915 and AU915

LoRaWANNode node(&radio, &Region);//, subBand);

#include "config.h"

// EUIs specific to this Heltec node
uint64_t joinEUI = RADIOLIB_LORAWAN_JOIN_EUI;
uint64_t devEUI  = RADIOLIB_LORAWAN_DEV_EUI;

// Using the same keys from node/config.h
uint8_t appKey[] = { RADIOLIB_LORAWAN_APP_KEY };
uint8_t nwkKey[] = { RADIOLIB_LORAWAN_NWK_KEY };

#define LORAWAN_UPLINK_DATA_RATE  2
#define LORAWAN_UPLINK_USER_PORT  2
#define LORAWAN_UPLINK_PERIOD_S   60          // seconds between uplinks
#define LORAWAN_UPLINK_PERIOD_US  (LORAWAN_UPLINK_PERIOD_S * 1000000ULL)

// ── Battery ADC (Heltec WiFi LoRa 32 V3) ────────────────────────
// The board has a built-in voltage divider: VBAT → R1(390k) → GPIO1 → R2(100k) → GND
// GPIO37 is the control pin — pull LOW to enable the divider, HIGH to disable it.
#define VBAT_ADC_PIN   1
#define VBAT_CTRL_PIN  37
#define VBAT_MIN       3.0f   // battery considered empty (V)
#define VBAT_MAX       4.2f   // battery considered full  (V)

#include <Preferences.h>
Preferences prefs;

// ── Read battery percentage (0–100) ─────────────────────────────
uint8_t readBatteryPercent() {
  pinMode(VBAT_CTRL_PIN, OUTPUT);
  digitalWrite(VBAT_CTRL_PIN, LOW);   // enable divider
  delay(10);                           // let ADC settle

  // Average 8 samples to reduce ADC noise
  int32_t raw = 0;
  for (int i = 0; i < 8; i++) {
    raw += analogRead(VBAT_ADC_PIN);
    delay(2);
  }
  raw /= 8;

  digitalWrite(VBAT_CTRL_PIN, HIGH);  // disable divider to save power

  // V_adc = (raw / 4095) * 3.3V
  // V_bat = V_adc * ((390k + 100k) / 100k) = V_adc * 4.9
  float voltage = (raw / 4095.0f) * 3.3f * 5.25f;
  Serial.printf("Measured voltage: %.3f V\n", voltage);  // add this

  // Map voltage to 0–100%
  float pct = (voltage - VBAT_MIN) / (VBAT_MAX - VBAT_MIN) * 100.0f;
  if (pct < 0.0f)   pct = 0.0f;
  if (pct > 100.0f) pct = 100.0f;
  return (uint8_t)pct;
}

void saveSession() {
  uint8_t *noncesBuffer = node.getBufferNonces();
  uint8_t *sessionBuffer = node.getBufferSession();
  
  prefs.begin("lorawan", false);
  prefs.putBytes("nonces", noncesBuffer, RADIOLIB_LORAWAN_NONCES_BUF_SIZE);
  prefs.putBytes("session", sessionBuffer, RADIOLIB_LORAWAN_SESSION_BUF_SIZE);
  prefs.end();
  Serial.println("Session & Nonces saved to Preferences");
}

void joinNetwork() {
  node.beginOTAA(joinEUI, devEUI, nwkKey, appKey);
  
  prefs.begin("lorawan", true); // read-only
  size_t noncesLen = prefs.getBytesLength("nonces");
  size_t sessionLen = prefs.getBytesLength("session");
  
  if (noncesLen == RADIOLIB_LORAWAN_NONCES_BUF_SIZE && sessionLen == RADIOLIB_LORAWAN_SESSION_BUF_SIZE) {
    uint8_t noncesBuffer[RADIOLIB_LORAWAN_NONCES_BUF_SIZE];
    uint8_t sessionBuffer[RADIOLIB_LORAWAN_SESSION_BUF_SIZE];
    prefs.getBytes("nonces", noncesBuffer, RADIOLIB_LORAWAN_NONCES_BUF_SIZE);
    prefs.getBytes("session", sessionBuffer, RADIOLIB_LORAWAN_SESSION_BUF_SIZE);
    node.setBufferNonces(noncesBuffer);
    node.setBufferSession(sessionBuffer);
    Serial.println("Restoring session from Preferences...");
    display.clear();
    display.println("Restoring Session...");
  } else {
    Serial.println("No saved session. Join ('login') the LoRaWAN Network...");
    display.clear();
    display.println("Joining Network...");
  }
  prefs.end();

  while (1) {
    int16_t state = node.activateOTAA();
    if (state == RADIOLIB_LORAWAN_NEW_SESSION) {
      Serial.println("Joined completely new session!");
      display.println("Joined New!");
      saveSession();
      break;
    } else if (state == RADIOLIB_LORAWAN_SESSION_RESTORED) {
      Serial.println("Session successfully restored!");
      display.println("Restored!");
      break;
    }
    Serial.printf("Join failed: %i\n", state);
    display.printf("Join fail: %i\n", state);
    delay(15000);
  }
  
  node.setADR(false);
  node.setDatarate(LORAWAN_UPLINK_DATA_RATE);
  node.setDutyCycle(false);
}

void setup() {
  heltec_setup();
  Serial.println("Serial works");
  
  display.clear();
  display.println("Setup LoRaWAN");
  
  int16_t state = radio.begin();
  if (state != RADIOLIB_ERR_NONE) {
    display.printf("radio.begin fail: %i\n", state);
    Serial.printf("Initialise radio failed: %i\n", state);
    while(1);
  }

  // Execute the persistent join logic
  joinNetwork();

  // ── Read battery level ───────────────────────────────────────
  uint8_t batPct = readBatteryPercent();
  Serial.printf("Battery: %u%%\n", batPct);

  // ── Build payload: [tempH][tempL][humH][humL][battery%] ──────
  // Bytes 0-1: temperature (placeholder, x10, signed int16)
  // Bytes 2-3: humidity    (placeholder, x10, uint16)
  // Byte  4:   battery %   (0-100)
  uint8_t uplinkPayload[5] = {0};
  uint16_t tempDecimal = 5;
  uint16_t humDecimal  = 10;
  uplinkPayload[0] = (tempDecimal >> 8);
  uplinkPayload[1] = tempDecimal & 0xFF;
  uplinkPayload[2] = (humDecimal >> 8);
  uplinkPayload[3] = humDecimal & 0xFF;
  uplinkPayload[4] = batPct;

  display.clear();
  display.println("Sending uplink...");
  display.printf("Battery: %u%%\n", batPct);
  Serial.println("Sending uplink");

  state = node.sendReceive(uplinkPayload, sizeof(uplinkPayload), LORAWAN_UPLINK_USER_PORT);
  if (state == RADIOLIB_ERR_NONE || state == RADIOLIB_LORAWAN_DOWNLINK) {
    display.println("TX Success!");
    Serial.println("Sending uplink successful!");
    saveSession();
  } else if (state == RADIOLIB_ERR_NETWORK_NOT_JOINED) {
    display.println("Lost Network!");
    Serial.println("Network not joined (-1101)! Rejoining...");
    // Rejoin will happen on next wake cycle
  } else {
    display.printf("TX fail: %i\n", state);
    Serial.printf("Error in sendReceive: %i\n", state);
  }

  Serial.printf("Going to sleep for %d seconds...\n", LORAWAN_UPLINK_PERIOD_S);
  display.clear();
  display.printf("Sleep %ds\nBat: %u%%", LORAWAN_UPLINK_PERIOD_S, batPct);
  delay(500); // brief pause so the display is visible

  // Deep sleep — wakes up and re-runs setup()
  heltec_deep_sleep(LORAWAN_UPLINK_PERIOD_S);
}

void loop() {
  // Not used — device deep sleeps after each uplink.
  // loop() is intentionally empty.
}