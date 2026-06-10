#include "config.h"
#include <Preferences.h>
#include <Wire.h>
#include <esp_sleep.h>

// regional choices: EU868, US915, AU915, AS923, IN865, KR920, CN780, CN500
const LoRaWANBand_t Region = AS923;

// SX1262 pin order: Module(NSS/CS, DIO1, RESET, BUSY);
SX1262 radio = new Module(41, 39, 42, 40);

// create the LoRaWAN node
LoRaWANNode node(&radio, &Region);

uint64_t joinEUI = RADIOLIB_LORAWAN_JOIN_EUI;
uint64_t devEUI = RADIOLIB_LORAWAN_DEV_EUI;
uint8_t appKey[] = {RADIOLIB_LORAWAN_APP_KEY};
uint8_t nwkKey[] = {RADIOLIB_LORAWAN_NWK_KEY};

Preferences prefs;

// ── Battery ADC ──────────────────────────────────────────────────
// Onboard voltage divider on D0 (ratio 1/2).
// analogReadMilliVolts() returns corrected mV at the pin.
// Calibration: code read 3.840 V vs multimeter 4.010 V
//   correction = 4.010 / 3.840 = 1.0443
//#define VBAT_ADC_PIN D0
//#define VBAT_CAL 1.0443f
//#define VBAT_MIN 3.0f // battery empty (V)
//#define VBAT_MAX 4.2f // battery full  (V)

//uint8_t readBatteryPercent() {
//  int32_t Vbatt = 0;
//  for (int i = 0; i < 8; i++) {
//    Vbatt += analogReadMilliVolts(VBAT_ADC_PIN);
//    delay(2);
//  }
//  float Vbattf = 2.0f * Vbatt / 8.0f / 1000.0f * VBAT_CAL;
//  Serial.printf("Battery voltage: %.3f V\n", Vbattf);

//  float pct = (Vbattf - VBAT_MIN) / (VBAT_MAX - VBAT_MIN) * 100.0f;
//  if (pct < 0.0f)
//   pct = 0.0f;
//  if (pct > 100.0f)
//    pct = 100.0f;
//  return (uint8_t)pct;
//}

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

  if (noncesLen == RADIOLIB_LORAWAN_NONCES_BUF_SIZE &&
      sessionLen == RADIOLIB_LORAWAN_SESSION_BUF_SIZE) {
    uint8_t noncesBuffer[RADIOLIB_LORAWAN_NONCES_BUF_SIZE];
    uint8_t sessionBuffer[RADIOLIB_LORAWAN_SESSION_BUF_SIZE];
    prefs.getBytes("nonces", noncesBuffer, RADIOLIB_LORAWAN_NONCES_BUF_SIZE);
    prefs.getBytes("session", sessionBuffer, RADIOLIB_LORAWAN_SESSION_BUF_SIZE);
    node.setBufferNonces(noncesBuffer);
    node.setBufferSession(sessionBuffer);
    Serial.println("Restoring session from Preferences...");
  } else {
    Serial.println("No saved session. Joining LoRaWAN Network...");
  }
  prefs.end();

  while (1) {
    int16_t state = node.activateOTAA();
    if (state == RADIOLIB_LORAWAN_NEW_SESSION) {
      Serial.println("Joined completely new session!");
      saveSession();
      break;
    } else if (state == RADIOLIB_LORAWAN_SESSION_RESTORED) {
      Serial.println("Session successfully restored!");
      break;
    }
    Serial.printf("Join failed: %i\n", state);
    delay(15000);
  }

  node.setADR(false);
  node.setDatarate(LORAWAN_UPLINK_DATA_RATE);
  node.setDutyCycle(false);
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("\nBooting..."));

  int16_t state = radio.begin();
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("Initialise radio failed: %i\n", state);
    while (1)
      ;
  }

  // SX1262 rf switch order: setRfSwitchPins(rxEn, txEn);
  radio.setRfSwitchPins(38, RADIOLIB_NC);

  // Execute the persistent join logic
  joinNetwork();

  // ── Read battery level ────────────────────────────────────────
  //uint8_t batPct = readBatteryPercent();
  //Serial.printf("Battery: %u%%\n", batPct);

  // ── Build payload: [tempH][tempL][humH][humL][battery%] ──────
  // Bytes 0-1: temperature (placeholder, x10, uint16 big-endian)
  // Bytes 2-3: humidity    (placeholder, x10, uint16 big-endian)
  // Byte  4:   battery %   (0-100)
  uint8_t uplinkPayload[4] = {0};
  uint16_t tempDecimal = 5;
  uint16_t humDecimal = 10;
  uplinkPayload[0] = (tempDecimal >> 8);
  uplinkPayload[1] = tempDecimal & 0xFF;
  uplinkPayload[2] = (humDecimal >> 8);
  uplinkPayload[3] = humDecimal & 0xFF;
  //uplinkPayload[4] = batPct;

  Serial.println("Sending uplink...");

  state = node.sendReceive(uplinkPayload, sizeof(uplinkPayload),
                           LORAWAN_UPLINK_USER_PORT);
  if (state == RADIOLIB_LORAWAN_DOWNLINK || state == RADIOLIB_ERR_NONE) {
    Serial.println("Uplink successful!");
    saveSession();
  } else if (state == RADIOLIB_ERR_NETWORK_NOT_JOINED) {
    Serial.println("Network not joined (-1101)! Will rejoin on next wake.");
  } else {
    Serial.print("Uplink failed: ");
    Serial.println(stateDecode(state));
  }

  Serial.printf("Sleeping for %d seconds...\n", LORAWAN_UPLINK_PERIOD / 1000);

  // Deep sleep — wakes up and re-runs setup()
  esp_sleep_enable_timer_wakeup((uint64_t)(LORAWAN_UPLINK_PERIOD) *
                                1000ULL); // ms → us

  // Put SX1262 to sleep and set RF switch control pin to INPUT to minimize
  // power leakage
  radio.sleep();
  pinMode(38, INPUT);

  esp_deep_sleep_start();
}

void loop() {
  // Not used — device deep sleeps after each uplink.
}
