# Mitsubishi Heavy Industries WF-RAC

This integration shows in Gladys the **Mitsubishi Heavy Industries** (MHI)
air conditioners fitted with the **WF-RAC** Wi-Fi adapter (the one of the
Smart M-Air app), through the local API of the adapter, without any cloud.

> **Never tested with a real device.** The protocol of the adapter is not
> documented by the manufacturer: the integration follows pywfrac and its Home
> Assistant integration, and was only tried against simulated answers (built
> from real frames those projects published). Your feedback is welcome.

Unofficial, not affiliated with Mitsubishi Heavy Industries.

**Not for Mitsubishi Electric**: Mitsubishi Electric air conditioners
(MELCloud) are handled by the MELCloud integration of the Gladys core.

## What you get

One device per adapter (one per indoor unit), with:

| Feature                                              | Gladys type                      | Command |
| ---------------------------------------------------- | -------------------------------- | ------- |
| On/off                                               | air conditioning, on/off         | yes     |
| Mode (automatic, cooling, heating, drying, fan only) | air conditioning, mode           | yes     |
| Setpoint (0.5 °C steps)                              | air conditioning, setpoint (°C)  | yes     |
| Fan speed (automatic, 1 to 4)                        | air conditioning, fan speed      | yes     |
| Vertical vane (swing, positions 1 to 4)              | air conditioning, vertical swing | yes     |
| Indoor temperature                                   | temperature sensor (°C)          | no      |
| Outdoor temperature                                  | temperature sensor (°C)          | no      |
| Error code of the unit                               | text                             | no      |

The setpoint is held to the range of the unit for the mode read just before:
16 to 30 °C in cooling, 18 to 30 °C otherwise; ZT models (2025) go from 10 °C
in heating up to 33 °C in cooling and drying. In fan only, the setpoint is the
one of the next mode: the range is that of all modes (16 to 30 °C, 10 to
33 °C on ZT). A value out of range is refused, never sent. A mode change
brings the setpoint read into the range of the new mode and sends it with it
(for example 10 °C in heating becomes 16 °C when switching to cooling).

## Setup

1. Give each adapter a **fixed IP address** in your router (it often shows
   under a name made of its MAC address).
2. In the configuration of the integration, enter the addresses, separated by
   commas (8 at most). The port is 51443; the integration finds on its own
   whether the adapter speaks HTTPS (tried first) or HTTP. The same adapter
   typed twice (IP address and name) is read once.
3. Save, then add the air conditioners from the **Discovery** tab.
4. To control them from Gladys, turn on **Allow the commands**.

Each adapter is read every 60 seconds (30 s to 10 min), one request at a
time, one second apart at least: the adapter takes one connection at a time.
After a failure, the adapter is read again after 30 s, 1, 2 then 5 min, never
sooner than the interval; the **Test the connection** button keeps that delay
and says when the next try comes.

## Commands and the registration on the adapter

Reading the state needs nothing. **Writing** needs Gladys to be registered on
the adapter, which has only **four slots** (the Smart M-Air app of each phone
takes one) and frees none on its own. Hence:

- commands are **off by default**: without the option, nothing is registered
  on the adapter;
- Gladys uses **one identifier** for the whole installation, written once in
  a file of its own in `/data`; if it cannot be written, Gladys does not
  register at all (each restart would take another slot). If that file
  becomes unreadable, it is set aside, Gladys makes no other on its own and
  the status says so: the **Register Gladys on the adapters** button makes a
  new one when you ask (the old slot stays taken, see "Uninstalling");
- it registers **once** per adapter; after a refusal it tries again at most
  once an hour, never in a loop;
- when the four slots are taken (the adapter counts four accounts) it no
  longer tries on its own: the status says so. Remove an app or a phone in
  Smart M-Air, then click **Register Gladys on the adapters**.

Each command:

- reads the state of the air conditioner again just before, and is decided on
  that read only (the adapter receives a full state: a frame built on an old
  state would undo what changed since);
- leaves within 3.5 seconds of the click, or is refused without being sent
  ("too slowly: not sent") when the adapter is slow to answer;
- checks the "Allow the commands" option on arrival and right before sending;
- is never sent again on its own. When the adapter does not answer after
  sending, the message is "Command sent, without confirmation": check the
  state a few seconds later (Gladys reads the unit again after 5 and 20
  seconds);
- is not sent when the air conditioner already is in the asked state;
- is refused when the frame read cannot be verified (its CRC does not match),
  or when the adapter gives no fresh state (result 0);
- is refused, unsent, when the previous command on another setting of the
  same air conditioner is not visible yet in the state read ("try again in a
  few seconds"): the frame would undo that command. Gladys never fills the
  state read in from its memory.

One command at a time per air conditioner: a second one, while a first one
is running, is refused.

**60-second lock.** Each successful write keeps writing to its author (the
device that sent it) for one minute; reads are not affected. So a Gladys
command sent less than a minute after a change made in the Smart M-Air app
(or another Wi-Fi controller) is refused ("try again in a minute"); Gladys
neither waits nor tries again. The other way round, the app is refused for
the minute after each Gladys command. The infrared remote does not go through
the adapter and is not affected.

**On/off and "turn everything off".** As with MELCloud, on/off is an
air-conditioning feature, not a switch. Depending on what exposes it (a voice
assistant, HomeKit, Google Home, MCP…), a "turn everything off" may reach the
air conditioner: check your scenes and assistants if you do not want that.

Changing the mode does not switch on an air conditioner that is off: only the
mode changes.

## Known limits

- No horizontal vane, 3D auto, self-clean, Home Leave mode, external room
  temperature, operation data nor energy in this version.
- On some units (old bus signature), the adapter does not report the
  horizontal vane position nor 3D auto: like the app and pywfrac, each command
  then sets them back to automatic / off.
- A value that cannot be read (a setpoint outside 10 to 33 °C, a temperature
  sensor absent or cut) is left unknown, never published.
- When the adapter is slow to answer (more than 2 to 3 seconds), commands are
  refused without being sent. Try again; tell us if it happens often.
- One Gladys installation per adapter is expected.

## Uninstalling

The slot Gladys takes on each adapter stays taken after uninstalling: this
version has no button to free it yet. Before uninstalling (or to free the old
slot after an unreadable identifier file), remove the matching entry in the
Smart M-Air app if it shows it (not checked: a client registered locally may
not appear there). Otherwise a reset of the adapter (see its manual) should
empty its account table (not checked); the phones then have to be paired
again.

## Security

The local API has **no password**: any device of the local network can read
and, once registered, control the air conditioner. Keep the adapters on a
**trusted network** (a guest network or a dedicated VLAN is a good idea).

Depending on its firmware, the adapter speaks HTTP or HTTPS. Over HTTPS its
certificate is self-signed and its TLS stack very old: the integration does
not check the certificate and accepts TLS 1.0 and later, OpenSSL security
level 0 and legacy renegotiation. This does not protect against a device
impersonating the adapter on your network. Over **HTTP** (the oldest
firmware), everything travels in plain text on the network, the identifier of
Gladys included.

The identifier of Gladys (operator and device) is kept in `/data`, never
written to the logs, and sent only to adapters already identified: the first
request to an address (which recognizes the adapter) carries a placeholder
identifier.

## Credits

The protocol is ported to JavaScript from
[pywfrac](https://github.com/blues-sechseck/pywfrac) 0.1.10 and the Home
Assistant integration
[Mitsubishi-WF-RAC-Integration](https://github.com/blues-sechseck/Mitsubishi-WF-RAC-Integration)
(jeatheak, blues-sechseck, MIT license), whose reference of the WF-RAC module
guided this work. See `THIRD_PARTY_NOTICES.md`.
