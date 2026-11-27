<p align="center">
	<a href="https://jblaha.art/sketchbook/latest"><img src="./src/img/thumbnail.png"></a>
	<br>
	<a href="https://jblaha.art/sketchbook/latest">Live demo</a>
	<br>
</p>

# Final update (20. Feb 2023)

As I have no more interest in developing this project, it comes to a conclusion. In order to remain honest about the true state of the project, I am archiving this repository.

- If you wish to modify Sketchbook feel free to fork it.
- To see if someone is currently maintaining a fork, check out the [Network Graph](https://github.com/swift502/Sketchbook/network).

# 📒 Sketchbook

Simple web based game engine built on [three.js](https://github.com/mrdoob/three.js) and [cannon.js](https://github.com/schteppe/cannon.js) focused on third-person character controls and related gameplay mechanics.

Mostly a playground for exploring how conventional third person gameplay mechanics found in modern games work and recreating them in a general way.

## Features

* World
	* Three.js scene
	* Cannon.js physics
	* Variable timescale
	* Frame skipping
	* FXAA anti-aliasing
* Characters
	* Third-person camera
	* Raycast character controller with capsule collisions
	* General state system
	* Character AI
* Vehicles
	* Cars
	* Airplanes
	* Helicopters
* Law enforcement roleplay
	* Police / sheriff duty and patrol vehicles
	* Glock 19 service-pistol label, nonlethal NPC taser, handcuffs, flashlight and traffic cones
	* In-vehicle MDT (`/`), in-vehicle radio (`R`), adjustable speed radar (`F6`), AI traffic stop request (`F7` in a patrol car), NPC conversation (`Q` on foot)
	* Local MDT incident/citation records and dispatch board; five server-scoped text radio channels
	* Furnished station reception desks and holding-cell doors restricted to on-duty law-enforcement jobs

The phone's Jobs app remains the only police-job/duty interface. While on duty, `/` opens the MDT inside a police or sheriff vehicle, `R` opens the vehicle radio, `F6` toggles the in-car speed radar (set a 5-100 mph limit), and `F7` in a patrol car requests an AI traffic car ahead to signal and gradually pull toward the roadside. On foot, `Q` starts an NPC conversation when aiming at someone nearby. Radar reads simulated traffic and nearby live/synchronized vehicles visible to the client. `T` deploys the nonlethal taser, `Shift+T` reloads its cartridges, `C` handcuffs a stunned NPC (or releases a detained NPC), `L` toggles the flashlight (or operates a nearby door lock), and `B` / `Shift+B` deploy/remove traffic cones. NPC interviews provide preset questions, mixed truthful/deceptive roleplay answers and a consent/detention-aware simulated search.

MDT records and NPC roleplay state are saved in the current browser only. Text radio can broadcast over the current multiplayer server's Realtime channel, but the existing game has no authenticated, trusted police backend; channel/dept restrictions and messages are therefore not server-authoritative. The radio is text-only; it does not yet include a vehicle CB/voice service. The traffic pull-over behavior applies to simulated AI traffic only, not player vehicles, and cannot guarantee a clear roadside shoulder.

Police cars now mount a configurable MDT laptop GLB (or a built-in fallback), and the `/` MDT opening focuses the vehicle camera on it before showing the MDT. Set `REALISM_CONFIG.police.mdtLaptop.model`, `position`, `rotation`, and `scale` in [realism-config.js](./realism-config.js) to fit a supplied model. The underground station garages, traffic yielding around stopped patrol vehicles, and player restraint/search support are still pending.

The multiplayer character editor now saves a male/female selection and uses the matching rigged model in `build/assets/characters/`. Adjust each model's `height`, `scale`, standing `y`, `seatedScale`, and `seatedY` under `REALISM_CONFIG.player.models` in [realism-config.js](./realism-config.js); these settings apply to the local player, multiplayer replicas, and matching NPC variants without changing the source GLBs. Heights are metres, `scale` is an additional multiplier, `seatedScale` multiplies the standing visual scale, and Y values are vertical offsets in metres. Save the config and hard-refresh; no build is needed for config-only edits. Player animations include walk/run plus generated idle, seated, driving, talking, and wave poses. Nearby NPCs use randomized supplied male/female GLB appearances with varied skin tones. Remote vehicles use the locally configured GLB for their vehicle type (or the matching stock car, helicopter, or airplane model). Clients need the same game build and `realism-config.js`/assets to see identical models; the game does not transfer model files between players.

All planned features can be found in the [GitHub Projects](https://github.com/swift502/Sketchbook/projects).

## Usage

You can define your own scenes in Blender, and then read them with Sketchbook. Sketchbook needs to run on a local server such as [http-server](https://www.npmjs.com/package/http-server) or [webpack-dev-server](https://github.com/webpack/webpack-dev-server) to be able to load external assets.

<!-- #### Script tag -->

1. Import:

```html
<script src="sketchbook.min.js"></script>
```

2. Load a glb scene defined in Blender:

```javascript
const world = new Sketchbook.World('scene.glb');
```

<!--

#### NPM

1. Install:

```
npm i sketchbook
```

2. Import:

```javascript
import { World } from 'sketchbook';
```

3. Load a glb scene defined in Blender:

```javascript
const world = new World('scene.glb');
```

-->

## Contributing

1. Get the LTS version of [Node.js](https://nodejs.org/en/) 16
2. [Fork this repository](https://help.github.com/en/github/getting-started-with-github/fork-a-repo)
3. Run `npm install`
4. Run `npm run dev`
5. Make changes and test them out at http://localhost:8080
6. Commit and [make a pull request](https://help.github.com/en/github/collaborating-with-issues-and-pull-requests/creating-a-pull-request-from-a-fork)!

## Credits

Big thank you to each of the following github users for contributing to Sketchbook:

- [aleqsunder](https://github.com/aleqsunder)
- [barhatsor](https://github.com/barhatsor)
- [danshuri](https://github.com/danshuri)
