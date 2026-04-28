#include "config.h"
#include "EEPROM.h"
#include <Wire.h>

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

#define SERIAL_DATA_BUF_LEN  64
uint8_t serialDataBuf[SERIAL_DATA_BUF_LEN] = {0};
uint8_t serialIndex = 0;

#define UPLINK_PAYLOAD_MAX_LEN  256
uint8_t uplinkPayload[UPLINK_PAYLOAD_MAX_LEN] = {0};
uint16_t uplinkPayloadLen = 0;

uint32_t previousMillis = 0;

void setup() {
  Serial.begin(115200);

  if (!EEPROM.begin(LORAWAN_DEV_INFO_SIZE)) {
    Serial.println("Failed to initialize EEPROM");
    while (1);
  }

  uint32_t now = millis();
  while (1) {
    deviceInfoSet();
    if (millis() - now >= 5000) break;
  }

  deviceInfoLoad();
  Serial.println(F("\nSetup... "));
  Serial.println(F("Initialise the radio"));
  int16_t state = radio.begin();
  radio.setOutputPower(22);
  debug(state != RADIOLIB_ERR_NONE, F("Initialise radio failed"), state, true);

  // SX1262 rf switch order: setRfSwitchPins(rxEn, txEn);
  radio.setRfSwitchPins(38, RADIOLIB_NC);

  // Setup the OTAA session information
  node.beginOTAA(joinEUI, devEUI, nwkKey, appKey);
  Serial.println(F("Join ('login') the LoRaWAN Network"));

  while (1) {
    state = node.activateOTAA(LORAWAN_UPLINK_DATA_RATE);
    if (state == RADIOLIB_LORAWAN_NEW_SESSION) break;
    debug(state != RADIOLIB_LORAWAN_NEW_SESSION, F("Join failed"), state, true);
    delay(15000);
  }

  node.setADR(false);
  node.setDatarate(LORAWAN_UPLINK_DATA_RATE);
  node.setDutyCycle(false);
  node.setDwellTime(false);

  Serial.println(F("Ready!\n"));

  Wire.begin();

  // Trigger first uplink immediately
  previousMillis = millis() - LORAWAN_UPLINK_PERIOD;
}

void loop() {
  uint32_t currentMillis = millis();
  if (currentMillis - previousMillis < LORAWAN_UPLINK_PERIOD) {
    // Not time yet — handle serial input and yield
    deviceInfoSet();
    delay(100);
    return;
  }
  previousMillis = currentMillis;

  // --- Build payload ---
  float temp_hum_val[2] = {0};
  uplinkPayloadLen = 0;
  memset(uplinkPayload, 0, sizeof(uplinkPayload));  // FIX: was memset(buf, size, 0) — args were swapped

  // TODO: replace hardcoded values with real sensor read
  // e.g. dht.readTempAndHumidity(temp_hum_val)
  // temp_hum_val[1] = temperature, temp_hum_val[0] = humidity
  uint16_t tempDecimal = (uint16_t)(temp_hum_val[1] * 100);  // e.g. 25.50°C -> 2550
  uint16_t humDecimal  = (uint16_t)(temp_hum_val[0] * 100);  // e.g. 65.00% -> 6500

  uplinkPayload[uplinkPayloadLen++] = (tempDecimal >> 8);
  uplinkPayload[uplinkPayloadLen++] = (tempDecimal & 0xFF);
  uplinkPayload[uplinkPayloadLen++] = (humDecimal >> 8);
  uplinkPayload[uplinkPayloadLen++] = (humDecimal & 0xFF);

  Serial.print("Temperature: ");
  Serial.print(temp_hum_val[1]);
  Serial.print(" *C, Humidity: ");
  Serial.println(temp_hum_val[0]);
  Serial.print("Uplink payload length: ");
  Serial.println(uplinkPayloadLen);
  Serial.print("Uplink payload: ");
  for (int i = 0; i < uplinkPayloadLen; i++) {
    Serial.print(uplinkPayload[i], HEX);
    Serial.print(" ");
  }
  Serial.println();

  // --- Send uplink (only once per cycle) ---
  int16_t state = node.sendReceive(uplinkPayload, uplinkPayloadLen, LORAWAN_UPLINK_USER_PORT);
  if (state == RADIOLIB_LORAWAN_DOWNLINK || state == RADIOLIB_ERR_NONE) {
    Serial.println("Uplink successful!");
  } else {
    Serial.print("Error in sendReceive: ");
    Serial.println(state);
    Serial.println(stateDecode(state));
  }
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

void deviceInfoSet() {
  if (Serial.available()) {
    serialDataBuf[serialIndex++] = Serial.read();
    if (serialIndex >= SERIAL_DATA_BUF_LEN) serialIndex = 0;
    if (serialIndex > 2 && serialDataBuf[serialIndex - 2] == '\r' && serialDataBuf[serialIndex - 1] == '\n') {
      Serial.println("Get serial data:");
      arrayDump(serialDataBuf, serialIndex);
      if (serialIndex == 34) {  // 8 + 8 + 16 + 2
        uint16_t checkSum = 0;
        for (int i = 0; i < 32; i++) checkSum += serialDataBuf[i];
        memcpy(deviceInfo, serialDataBuf, 32);
        memcpy(deviceInfo + 32, (uint8_t *)(&checkSum), 2);
        for (int i = 0; i < 34; i++) EEPROM.write(i, deviceInfo[i]);
        EEPROM.commit();
        Serial.println("Save serial data, please reboot...");
      } else {
        Serial.println("Error serial data length");
      }
      serialIndex = 0;
      memset(serialDataBuf, 0, sizeof(serialDataBuf));  // FIX: args were swapped
    }
  }
}
