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
#define LORAWAN_UPLINK_PERIOD     10000 // ms

uint32_t previousMillis = 0;

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

  // Setup the OTAA session information
  node.beginOTAA(joinEUI, devEUI, nwkKey, appKey);
  display.println("Joining Network...");
  Serial.println("Join ('login') the LoRaWAN Network");

  while(1) {
    state = node.activateOTAA();
    if(state == RADIOLIB_LORAWAN_NEW_SESSION) {
      display.println("Joined!");
      break;
    }
    display.printf("Join fail: %i\n", state);
    Serial.printf("Join failed: %i\n", state);
    delay(15000);
  }

  // Disable the ADR algorithm (on by default which is preferable)
  node.setADR(false);

  // Set a fixed datarate
  node.setDatarate(LORAWAN_UPLINK_DATA_RATE);

  // Manages uplink intervals to the TTN Fair Use Policy
  node.setDutyCycle(false);
  
  Serial.println("Ready!\n");
}

void loop() {
  heltec_loop();
  
  uint32_t currentMillis = millis();
  if (currentMillis - previousMillis >= LORAWAN_UPLINK_PERIOD) {
    previousMillis = currentMillis;

    // Dummy payload, just sending some data like in node.ino
    uint8_t uplinkPayload[4] = {0};
    uint16_t tempDecimal = 5;
    uint16_t humDecimal = 10;
    uplinkPayload[0] = (tempDecimal >> 8);
    uplinkPayload[1] = tempDecimal & 0xFF;
    uplinkPayload[2] = (humDecimal >> 8);
    uplinkPayload[3] = humDecimal & 0xFF;

    display.clear();
    display.println("Sending uplink...");
    Serial.println("Sending uplink");

    int16_t state = node.sendReceive(uplinkPayload, sizeof(uplinkPayload), LORAWAN_UPLINK_USER_PORT);
    if (state != RADIOLIB_ERR_NONE && state != RADIOLIB_LORAWAN_DOWNLINK) {
      display.printf("TX fail: %i\n", state);
      Serial.printf("Error in sendReceive: %i\n", state);
    } else {
      display.println("TX Success!");
      Serial.println("Sending uplink successful!");
    }
  }

  // Button
  if (button.isSingleClick()) {
    display.println("Button works");
    // LED
    for (int n = 0; n <= 100; n++) { heltec_led(n); delay(5); }
    for (int n = 100; n >= 0; n--) { heltec_led(n); delay(5); }
    display.println("LED works");
  }
}