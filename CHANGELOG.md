# Changelog

## [0.1.3](https://github.com/kalynnka/agent-debrief/compare/0.1.2...0.1.3) (2026-08-12)


### Bug Fixes

* **comments:** draw an open thread on the revision it was written against ([b2000ea](https://github.com/kalynnka/agent-debrief/commit/b2000ea943435f910afb0b53f0af2037bf332af5))
* **comments:** draw an open thread on the revision it was written against ([2f330c3](https://github.com/kalynnka/agent-debrief/commit/2f330c323e2ff141ea973bd78c7fde65a7a7aa79))
* **lane:** a cleared lane's baseline expires with its revision ([689d60a](https://github.com/kalynnka/agent-debrief/commit/689d60a2de06d05681cc7eeb3124a049c56adc23))
* **lane:** a cleared lane's baseline expires with its revision ([501fbb5](https://github.com/kalynnka/agent-debrief/commit/501fbb50ff685b36c9265568f6cdd7e0bdf2606f))


### Performance

* **gitwatch:** read a repository's shape once per burst, not once per event ([61644e8](https://github.com/kalynnka/agent-debrief/commit/61644e80b81bae912abb1068263a6528312f14ed))
* **gitwatch:** read a repository's shape once per burst, not once per event ([0073c53](https://github.com/kalynnka/agent-debrief/commit/0073c538a5ae2cf3dfc48df4eed59311f20eae38))

## [0.1.2](https://github.com/kalynnka/agent-debrief/compare/0.1.1...0.1.2) (2026-08-10)


### Bug Fixes

* **release:** publish npm on the token, not on an identity that does not exist ([e0238e2](https://github.com/kalynnka/agent-debrief/commit/e0238e24400ec89355d58b20abd704ef24e0fd01))


### Documentation

* **releasing:** npm is a token again, and why the other path failed ([43128f1](https://github.com/kalynnka/agent-debrief/commit/43128f10ef62d3dc31aa3d7357d41dea0f6e7681))

## [0.1.1](https://github.com/kalynnka/agent-debrief/compare/0.1.0...0.1.1) (2026-08-10)


### Features

* **snapshots:** forget a snapshot, keep the files ([4413d6c](https://github.com/kalynnka/agent-debrief/commit/4413d6c579823b7b9c72505f1888a1f31bbd0258))


### Bug Fixes

* **brand:** the icon's corners are transparent, not white ([a242150](https://github.com/kalynnka/agent-debrief/commit/a2421504992a41e2d7bd088eeb5d66137675a307))
* **revert:** stop giving back what the branch already holds ([7f844ba](https://github.com/kalynnka/agent-debrief/commit/7f844badd5e673d0757acf582d201bea0436be88))
* **review:** a commit cannot take a snapshot made after it ([cd71342](https://github.com/kalynnka/agent-debrief/commit/cd713426137c700993b3223ed542308479d2d806))
* **review:** a renamed-away path stops pinning its snapshot open ([8d28557](https://github.com/kalynnka/agent-debrief/commit/8d28557017d84a42fd6c4da45b608061c8be47b7))
* **review:** the bound belongs on where the work began, not on the snapshot ([eeedab3](https://github.com/kalynnka/agent-debrief/commit/eeedab39815f87cf1a74e3f995d901e0bfde3a6e))
* **snapshots:** a file the branch already holds is not outstanding ([ae92e92](https://github.com/kalynnka/agent-debrief/commit/ae92e921b5eaa867f195a079740a44f75e1f5582))


### Documentation

* a hook instruction that names no single host ([85a427f](https://github.com/kalynnka/agent-debrief/commit/85a427fa69cc9c3dd596d27d619aa9f4871171d4))
* a row says what became of its change ([77871de](https://github.com/kalynnka/agent-debrief/commit/77871de3c450f797fbe7566905985c9d2202e9b7))
* **readme:** hand the CLI setup to the agent ([cc1c182](https://github.com/kalynnka/agent-debrief/commit/cc1c182fd7cb5b4b02db71037287b88db14c5c93))
* **releasing:** merging a pull request is the gate now ([70e7bb3](https://github.com/kalynnka/agent-debrief/commit/70e7bb3d03b3fcc053e46dcf5f56fdbe8b769045))
* **releasing:** where the release-please PAT comes from ([f50397b](https://github.com/kalynnka/agent-debrief/commit/f50397be2c7ce9a15993718dc20bf533d81ef9bf))
* the agent takes the snapshots, the hook only guarantees them ([b8b4bd0](https://github.com/kalynnka/agent-debrief/commit/b8b4bd0bfeca015ea7201022a6514da0cc651159))
* the landing bound, and what it does to work written over ([f2714b5](https://github.com/kalynnka/agent-debrief/commit/f2714b5b27efdfa05eac1e315c18ccb50e2164e0))
