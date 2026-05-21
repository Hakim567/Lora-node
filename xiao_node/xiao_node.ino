#include "config.h"
#include "EEPROM.h"
#include <Wire.h>
#include <esp_sleep.h>

// regional choices: EU868, US915, AU915, AS923, IN865, KR920, CN780, CN500
const LoRaWANBand_t Region = AS923;

// SX1262 pin order: Module(NSS/CS, DIO1, RESET, BUSY);
SX1262 radio = new Module(41, 39, 42, 40);

// create the LoRaWAN node
LoRaWANNode node(&radio, &Region);

uint64_t joinEUI =   RADIOLIB_LORAWAN_JOIN_EUI;
uint64_t devEUI  =   RADIOLIB_LORAWAN_DEV_EUI;
uint8_t appKey[] = { RADIOLIB_LORAWAN_APP_KEY };
uint8_t nwkKey[] = { RADIOLIB_LORAWAN_NWK_KEY };

#define LORAWAN_DEV_INFO_SIZE 36
uint8_t deviceInfo[LORAWAN_DEV_INFO_SIZE] = {0};



#define RADIOLIB_SESSION_EEPROM_ADDR 64

// ── Battery ADC ──────────────────────────────────────────────────
// Onboard voltage divider on D0 (ratio 1/2).
// analogReadMilliVolts() returns corrected mV at the pin.
// Calibration: code read 3.840 V vs multimeter 4.010 V
//   correction = 4.010 / 3.840 = 1.0443
#define VBAT_ADC_PIN  D0
#define VBAT_CAL      1.0443f
#define VBAT_MIN      3.0f     // battery empty (V)
#define VBAT_MAX      4.2f     // battery full  (V)

uint8_t readBatteryPercent() {
  int32_t Vbatt = 0;
  for (int i = 0; i < 8; i++) {
    Vbatt += analogReadMilliVolts(VBAT_ADC_PIN);
  }
  float Vbattf = 2.0f * Vbatt / 8.0f / 1000.0f * VBAT_CAL;
  Serial.printf("Battery voltage: %.3f V\n", Vbattf);

  float pct = (Vbattf - VBAT_MIN) / (VBAT_MAX - VBAT_MIN) * 100.0f;
  if (pct < 0.0f)   pct = 0.0f;
  if (pct > 100.0f) pct = 100.0f;
  return (uint8_t)pct;
}

void saveSession() {
  uint8_t *noncesBuffer = node.getBufferNonces();
  uint8_t *sessionBuffer = node.getBufferSession();

  EEPROM.write(RADIOLIB_SESSION_EEPROM_ADDR, 0xAA);
  int addr = RADIOLIB_SESSION_EEPROM_ADDR + 1;

  for (size_t i = 0; i < RADIOLIB_LORAWAN_NONCES_BUF_SIZE; i++) {
    EEPROM.write(addr++, noncesBuffer[i]);
  }
  for (size_t i = 0; i < RADIOLIB_LORAWAN_SESSION_BUF_SIZE; i++) {
    EEPROM.write(addr++, sessionBuffer[i]);
  }
  EEPROM.commit();
  Serial.println("Session & Nonces saved to EEPROM");
}

void joinNetwork() {
  node.beginOTAA(joinEUI, devEUI, nwkKey, appKey);

  if (EEPROM.read(RADIOLIB_SESSION_EEPROM_ADDR) == 0xAA) {
    uint8_t noncesBuffer[RADIOLIB_LORAWAN_NONCES_BUF_SIZE];
    uint8_t sessionBuffer[RADIOLIB_LORAWAN_SESSION_BUF_SIZE];
    int addr = RADIOLIB_SESSION_EEPROM_ADDR + 1;

    for (size_t i = 0; i < RADIOLIB_LORAWAN_NONCES_BUF_SIZE; i++) {
      noncesBuffer[i] = EEPROM.read(addr++);
    }
    for (size_t i = 0; i < RADIOLIB_LORAWAN_SESSION_BUF_SIZE; i++) {
      sessionBuffer[i] = EEPROM.read(addr++);
    }
    node.setBufferNonces(noncesBuffer);
    node.setBufferSession(sessionBuffer);
    Serial.println("Restoring session from EEPROM...");
  } else {
    Serial.println("No saved session. Joining LoRaWAN Network...");
  }

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
    debug(true, F("Join failed"), state, false);
    delay(15000);
  }

  node.setADR(false);
  node.setDatarate(LORAWAN_UPLINK_DATA_RATE);
  node.setDutyCycle(false);
  node.setDwellTime(false);
}

void setup() {
  Serial.begin(115200);

  if (!EEPROM.begin(512)) {
    Serial.println("Failed to initialize EEPROM");
    while (1);
  }



  deviceInfoLoad();
  Serial.println(F("\nBooting..."));

  int16_t state = radio.begin();
  debug(state != RADIOLIB_ERR_NONE, F("Initialise radio failed"), state, true);

  // SX1262 rf switch order: setRfSwitchPins(rxEn, txEn);
  radio.setRfSwitchPins(38, RADIOLIB_NC);

  // Execute the persistent join logic
  joinNetwork();

  // ── Read battery level ────────────────────────────────────────
  uint8_t batPct = readBatteryPercent();
  Serial.printf("Battery: %u%%\n", batPct);

  // ── Build payload ─────────────────────────────────────────────
  // Bytes 0-1: temperature (×100, uint16 big-endian)
  // Bytes 2-3: humidity    (×100, uint16 big-endian)
  // Byte  4:   battery %   (0-100)
  uint8_t uplinkPayload[5] = {0};
  uint16_t uplinkPayloadLen = 0;

  float temp_hum_val[2] = {0};
  // TODO: replace with real sensor read
  // e.g. dht.readTempAndHumidity(temp_hum_val)
  uint16_t tempDecimal = (uint16_t)(temp_hum_val[1] * 100);
  uint16_t humDecimal  = (uint16_t)(temp_hum_val[0] * 100);

  uplinkPayload[uplinkPayloadLen++] = (tempDecimal >> 8);
  uplinkPayload[uplinkPayloadLen++] = (tempDecimal & 0xFF);
  uplinkPayload[uplinkPayloadLen++] = (humDecimal >> 8);
  uplinkPayload[uplinkPayloadLen++] = (humDecimal & 0xFF);
  uplinkPayload[uplinkPayloadLen++] = batPct;

  Serial.println("Sending uplink...");

  state = node.sendReceive(uplinkPayload, uplinkPayloadLen, LORAWAN_UPLINK_USER_PORT);
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
  esp_sleep_enable_timer_wakeup((uint64_t)(LORAWAN_UPLINK_PERIOD) * 1000ULL); // ms → us

  // Put SX1262 to sleep and set RF switch control pin to INPUT to minimize power leakage
  radio.sleep();
  pinMode(38, INPUT);

  esp_deep_sleep_start();
}

void loop() {
  // Not used — device deep sleeps after each uplink.
}

void deviceInfoLoad() {
  uint16_t checkSum = 0, checkSum_ = 0;
  for (int i = 0; i < LORAWAN_DEV_INFO_SIZE; i++) deviceInfo[i] = EEPROM.read(i);
  for (int i = 0; i < 32; i++) checkSum += deviceInfo[i];
  memcpy((uint8_t *)(&checkSum_), deviceInfo + 32, 2);

  if (checkSum == checkSum_) {
    memcpyr((uint8_t *)(&joinEUI), deviceInfo, 8);
    memcpyr((uint8_t *)(&devEUI), deviceInfo + 8, 8);
    memcpy(appKey, deviceInfo + 16, 16);

    Serial.println("Load device info:");
    Serial.print("JoinEUI:"); Serial.println(joinEUI, HEX);
    Serial.print("DevEUI:");  Serial.println(devEUI, HEX);
    Serial.print("AppKey:");  arrayDump(appKey, 16);
    Serial.print("nwkKey:");  arrayDump(nwkKey, 16);
  } else {
    Serial.println("Use the default device info as LoRaWAN param");
  }
}


