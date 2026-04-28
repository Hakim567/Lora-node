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

// EUIs specific to this Heltec node
uint64_t joinEUI = 0x6B7DE864E65C8E74;
uint64_t devEUI  = 0xCF6AF94F5F7BDB81;

// Using the same keys from node/config.h
uint8_t appKey[] = { 0x78, 0x70, 0xC5, 0x8D, 0x30, 0xAD, 0xF1, 0x56, 0xBC, 0xBF, 0x08, 0x7A, 0xCC, 0x7A, 0xD6, 0xE4 };
uint8_t nwkKey[] = { 0x9A, 0x31, 0xEC, 0x45, 0xEE, 0x0C, 0xF7, 0xA4, 0x36, 0xC9, 0xEF, 0x88, 0xEE, 0xD7, 0xD2, 0x01 };

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