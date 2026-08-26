Open Arena Expanded
Status: Beta 44
License: GPLv2 or later

Source!
Autodownload is not suited for source
If you got this from an autodownload you can get the source from the homepage or contact openarena@poulsander.com 

Both tar-balls, the svn tree and documentationare availble at http://code.google.com/p/oax/

This is the "technologi preview" of Open Arena 0.8.2
This mod should be player on the most recent SVN version for maximum results.

Install:
Unpack the oaxB44 into your openarena folder (the one with baseoa), a new folder named 'oaxB44' should be created
Start Open Arena
Go to mods and load oaxB44

New in Beta 44:
* cg_crosshairHealth toggleable in the menu
* Fixed crash during intermission in Elimination and CTF Elimination if a human was dead while the capturelimit was reached and possible other situations.

New in Beta 43:
* Colored crosshair support by chaing RGB values
* BG_CanAlloc introduced, can predict out-of-memory errors and handle them - adding too many bots no longer crashes the game
* Some missing blueish menu items
* Added g_catchup, that makes cheap frags a little more expensive if activated
* A few notices added to UI in different places
* Server source is now: Internet, Internet(2), Internet(3) ... instead of Internet1, Internet2, Internet3 ...
* Dead players are sorted last in Elimination/CTF Elimination
* Some imports from ioquake3: Ratio selection, new ClientCleanName and new bglib

New in Beta 42:
* g_persistantpowerups is now renamed to g_runes
* vertex light is no longer forced on in single player
* Now runs the correct logic then a single player map ends
* Blueish menu
* Added clientkick_game, same as clientkick but located in the game code, so it can be improved without touching the engine
* Double Domination counter will no longer count forever during warmup (however points will not respawn)

New in Beta 41:
* Persistant powerups are now toggleable (default off in baseoa, default on in missionpack) - g_persistantpowerups
* Penality points in 1 on 1 are awarded to the opponent rather than subtracted.
* Negative scores in FFA are no longer possible. 
* Changed default ammo count in Elimination
* Exclude bots from duplicate names check
* Missionpack now supports ui_humansonly
* Fixed wrong gamenames in Missionpack server browser
* Removed Mplayer as an option in Missionpack server browser (still no support for different master servers through)
* Removed remaining references to punkbuster
* Kemikazie and Invincibility are now availeble (beware that Invincibility is missing models). Availble in bases3 only (as far as I know)
* Fixed infinity loop bug in AAS code caused by the gametype flag.
* Generally improved the bot's Area Awareness System. 
* Added basic 'fariness' system. The CVAR is 'fairflags'. Default value 7 (1+2+4). 1 verifies some basic values. 2 verifies some extended graphics settings. 4 disables vertex light.  
* Added CVAR cg_autovertex. Automatically enables vertex light if allowed. Off by default. Gets enabled if you enable vertex light through the menu.
Note: The fairness system might result in a vid_restart if it detects a bad r_ cvar after the render has been initialized

New in Beta 40:
* Fixed CleanStr
* Added color 8 (menu color)
* BG_Alloc/BG_Free added. replaces G_Alloc
* Mines will self destruct very quickly if placed near the flag
* Kill sprees/death sprees and multikills added
* Some fixes backported from ioquake3
* Servers with no humans on are considered empty if "Only humans" is enabled
* Added elimination_lockspectator: 0=no lock, 1=cannot follow enemy, 2=must follow teammate (For Elimination and CTF Elimination only)
* Different crosshairs per weapon
* Crosshair pusle can be disabled
* Skulls are now visible on Skull carriar in Harvester
* Bots are now a little better at understanding prox mines
* Added deathShader to scoreboard in missionpack (for Elimination and CTF Elimination only, missionpack only)
* Breath and Dust effect backported from missionpack
* Added elimflags and voteflags than are now used to tranfer some booleans to save network traffic
* Vote system is more secure
* Vote can now pass even if majority is not reached then time runs out. It requires twice as many yes votes as no votes through or high percentage of yes votes.
* log2stdout cvar removed
* Teams can now be shuffled 
* pmove_fixed on be default
* pmove_msec defaults to 11 (controversial - I know)
* Non-rcon based admin system (ban, kick, lock teams, cancel votes etc.)
* Shullfle teams function added. Can be called by an admin "shuffle" or by "callvote shuffle"
* Parts of code has been cleaned a little
* Duplicate GUID check
* Added G_GlobalSound
* Server command handling now modularized ( ClientCommand & ConsoleCommand )

New in beta 39:
* Fixed double throw bug when a client disconnected
* No killed message then a client leaves (still counts as a suicide)
* Added 91 Hz fixed framerate to startserver (pmove_msec 11)
* More ingame information about pmove

New in Beta 38:
* g_humanplayers always 0 during intermission
* bots now reads team status from game rather than ai config string. Hopefully stopping bots from shoting at there own team during certain changes.
* challenges.cfg renamed to challenges.dat, to indicate that it is not an text file
* Removed compiler warning in TeamCvarSet
* pmoved_fixed now gets disabled if pmove_float is selected in the UI

New in Beta 37:
* g_humanplayers might make fewer mistakes now
* Gametype filter now also works for One Flag, Obelisk, Harvester and Domination
* First Connect screen reminds new players of some important settings
* bot_nochat >= 2 will now stop all bot chat
* Added "Optimize for LAN" to "start server" 
* Added "Physics" to "start server"
* Added "Oneway capture" to "start server" for the CTF Elimination gametype
* Added comments to pure and All Rockets in "start server"
* Fixed LMS mode bug in "start server"

New in Beta 36:
* Callvote map menu now responds the first time it is activated
* pmove_float added. Makes the physics framerate independent but cost up to 8 times as much network traffic (worst case, normally only a few percent). Mostly for LAN gaming. Note that you must reduce g_gravity to ~756 to get 125 fps gravity.
* Fixed vote exploit (some bugs still remain, needs rewrite)
* Fixed a bug that allowed a client to call more than 3 votes in a single game.
* cg_oldRail now defaults to 0
* Added restore system based on guid. You no longer lose scores when changing team, spectating or leave+rejoin
* Chainging team or leaving the game now counts as a suicide to prevent misuse of the restore system. In Team Deathmatch the team will be compensated so they don't loose points by loosing a player to the other team.
* You cannot ban localhost anymore (the system needs rewrite)
* g_elimination cvar added (like g_instantgib and g_rockets, but full elimination arsenal, health and damage rules)

New in Beta 35:
* You can now command bots in One Flag, Harvester, Obelisk and Domination.
* Last Man Standing will no longer count connecting players as survivors.
* Quad will no longer spawn if q_quadfactor <= 1.0
* Added CVAR 'g_logfile2stdout'. If set to 1 on a dedicated server a copy of the log will also be sent to standard out. Removes debug information from stdout. Must be considered experimental. Garbage data might occour. 
* Changed the way the game picks the spawn point to prevent maps with few spawnpoints that are marked with nobot or nohuman from hanging the game.
* Midair suicide while g_awardpushing is enabled will result in a point to the attacker.
* cl_guid is now written to the log file for all human players joining

New in Beta 34:
* Can now handle 20*1024 charecters in the *.arena file list. Significantly increases the number of maps supported.
* No maps are ignored if number of single player maps are not divideble by 4.
* CVAR_SYSTEMINFO is now set in cgame to allow game to override them
* Powerups recorded in stats
* Support for custom votes with a votecustom.cfg (I shall post an example)

New in Beta 33:
* Call Vote Map implemented
* Fixed infinity loop bug caused by bot_roams with gametype flags
* Gametype flag "ctfelimination" removed, replaced by "ctf"
* Password promt when joining servers
* g_humanplayers is no longer a SERVERINFO CVAR
* g_lms_mode is now a SERVERINFO CVAR
* Changed tab order in some vote menues
* If gametype are changed by a vote then the map will now automatically restart and reassign nextmap.
* You no longer get grauntlet award against bots in stats
* Stats no longer recorded during warmup
* Hook are no longer selected by default on spawn
* Flags are used for domination points instead of using Point A from DD

New in Beta 32:
* Grapple can be bound in option menu
* Grapple is now placed before gauntlet
* Grapple will never be selected then autoswitching from a weapon because you ran out of ammo
* You can get "No ammo" even if you have the grapple
* Client side cvar "cg_cyclegrapple" to tell if Grapple should be part of the weapon cycle. Default is 1 since there are no default key.
* Allowed maps for voting is now read from votemaps.cfg if it exists.
* Call Vote is grayed if disabled on the server
* Call Vote Kick implemented (uses clientkick to kick players)
* Server side cvar "elimination_grapple" added. Allows grapple in elimination gametypes.

New in Beta 31:
* Vote system now a lot more robust. Especially the kick functions are now more likely to kick the correct player
* Vote menu for calling votes - does not yet support Kick and Map functions.
* Clamp on cg_errorDecay as suggested by jessicaRA
* New ui_demo2.c by jessicaRA
* From ioquake3 svn-1492: fix overflow in CG_ParseTeamInfo
* From ioquake3 svn-1494: fix potential segfault (found by DerSaidin in xreal)
* From ioquake3 svn-1493: security fix: prevent command injection via callvote
* Mouse wheel works in mods menu

New in Beta 30:
Bots now attack the Obelisk in Overload
Bots should now acknowlegde the gametype property of items (not tested)
If g_awardPushing is enabled players will get frags for killing with a mover (be aware that this makes it possible to be noted for a teamkill even if friendly fire is off)
Changed message for teamkill from "you fragged <TARGET>" to "you fragged ^1TEAMMATE^7 <TARGET>"
Telefrags and crushing are now in Stats
Team only voice chat (cg_voipTeamOnly) enabled by default. While this function is enabled any value the player assign to "cl_voipSendTarget" will be overwritten when a player joins or leaves the team.
Crosshairs will now change to white if a colored crosshair is choosen and for some reason the server does not support it.

New in Beta 29:
Chaingun kill message is no longer the same as the machinegun kill message
bot_minplayers works better but still not perfect.
Starting challenge system programming. Currently there are no challenges, it only counts kills and awards against humans. Therefore it is currently called 'statistics'

New in Beta 28:
Chaingun prediction effect while unlagged
Some model/name changes in missionpack

New in Beta 27:
Harvester fixed
You can mine yourself now
Number of skulls is printed in Harvester
Flag status in One Flag Capture is on the screen
oneflag, overload, harvester and dom are now selecteble through the UI

New in Beta 26:
Load flagbase in baseoa in CTF games to stop the null from appearing at the flags.
VMs believes they are baseoa
Fixed LMS not accepting notteam anymore.
follow1 and follow2 no longer causes an infite loop when cycling. 
Includes spectators then counting humans
Big fat text in the middle of the screen then a team is dominating in DD

New in Beta 25 (0.8.0):
Print protocol number of different from 70 (0.8.x default)

New in Beta 24:
Larger buffer to hold all colors in server names (to prevent a new sprintf overflow like 0.7.6)
No more color overwrite in server browser
cvar vote strings are no longer SYSTEMINFO
Removed some CVARs only relevant for Missionpack in baseoa
Removed g_lightningdamage cvar

New in Beta 23:
Fixed missing Point B (White) in Double Domination
Added function to filter bots in server browser (requires new engine)
Added function to filter private servers in the browser (requires new engine)
Sends names of allowed votes if a wrong command is entered
Removes mines in Elimination, CTF Elimination and LMS between rounds
Now shows if it is a IPv4 or IPv6 server in games browser
Stereo vision
Removed credits (there was none anyway)
Removed Cinematics (the list was almost empty)

New in Beta 22:
Renamed the mod
Team spawn points in Double Domination (optional)
Log information about Awards, captures, rounds etc. (Not yet in harvester, Obelisk and Last Man Standing)
Removed "Dedicated" option from "Start Server". It caused a nasty freeze when used.
Removed unimplemented "g_voteStrictGametypes"

New in Beta 21:
Based on 0.7.7
Most changes from B20 is not included!
Uses optimized collision detection again (like 0.7.7 but unlike B19 and B20)
Missionpack weapons useable in baseoa
One Flag Capture, Harvester and Obelisk avaieble in baseoa (although some gui elements are missing not to mention all models)
Bots should be slightly more inteligent in standard domination
The new gametypes now accepts elimination, ctfelimination, lms, dd and dom to be used in "gametype" parameter in map entities. However this breaks many 0.7.7 maps.
New way of showing domination point status in Double Domination

New in Beta 20:
Some of beast's changes to server list
More player spots in Gui, better bot manegment (but not beast's preferred bots yet)
Some cleanup to collision detection
Placeholder icons for Double Domination points

New in Beta 19:
Instantgib and All rockets disabled during single player startup
Clears nextmap after single player
Beginning vote restriction
Smooth clients reverted to pre-unlagged
Colision detection reverted to 0.7.0
Logging fixed
Fixed com_spintf overflows in the server list

New in Beta 18:
baseoa 0.7.6
Unlagged disabled by default
Different standard bots (safe)

New in Beta 17:
You have taken/are tied for/lost the lead sounds playing in Last Man Standing
Fixed hanging bug in Last Man Standing
Last Man Standing scoring mode slecteble from the GUI
Removed GUI references to Punk Buster and CD key
Added "Always show weapon bar" to the Game Options
Added "Instant gib" and "All rockets" to the Start Server screen
Removed Friendly fire option in Elimination Games as it is ignored anyway (elimination_selfdamage = 2 should be used instead)
Double Domination default UI value can now be controlled using CVARS.

New in Beta 16:
Merged Niel Toronto's Unlagged code into elimination (except for lag simulation)
UI enchancements to the game server screen (such as default capturelimit in Elimination to 8)
openAL can be enabled and disabled from the menu
cg_alwaysWeaponBar allows people to turn the weapon bar permanently on

New in Beta 15:
Added "Auto join" to the classic join game menu. This automatically joins the weakest team (following the auto balance rule). (This was suggested by kick52)
Sending people to there death with knockback damage now counts as a kill.
Bots accepts orders in Double Domination again.

New in Beta 14:
Matchwarmup now useable in Elimination/CTF Elimination/LMS/DD/Standard Domination
Weapons enabled in warmup and while waiting for other players.

New in Beta 13:
Fixed player bar color when spectating in Elimination/CTF Elimination
Lives are now showed in LMS instead of "*DEAD*"
No shaking camera then hit in LMS, Elimination, CTF Elimination. It is mostly noticed in overtime in LMS.
Prevent elimination warmup CVARs from taking bad values.

New in Beta 12:
The other rocket arena type... by dmn_clown (taken from OA svn)
Some other things from SVN (including a WTF bug)
Standard Domination
One test map

New in Beta 11:
Used some of next ghosts patch file to fix some bugs
Fixed the bugs caused by fixing the above bugs
No defend bonus for the attacking team in Oneway CTF
Some chat commands + chat analysing + bot leadership in Double Domination
Warning: I have not worked on this on my own computer, so I haven't tested on missionpack.
Oneway CTf bot strategy might not be the best.

New in Beta 10:
Build on SVN 625 + instantgib missionpackbug
Added elimination_ctf_oneway, if set to '1' only one team can attack. Bots don't really understand this yet but I think I can get it.
Fixed flags respawn bug introduced in B9.
Bots now have a basic understanding of Double Domination and will try to capture the points, however they will not cooperate
Domination points from SVN is included for people who test on 0.7.x

New in Beta 9:
Reenabled spectator following when dead, now without score bug
Spectators can now use teleporters
Spectators can teleport though doors
Added a message to the client informing of the possibility to leave spectator mode by pressing USE_ITEM
Added cvars for all weapons but gauntlet
Added chaingun, nailgun and proxy mine launcher in missionpack
Maybe solved the bot_min_players+no humans+forcejoin bug
Mines now work in LMS
Some code fixes incl possible pointer problems
You cannot loose points by killing yourself/team mates in Elimination/CTF Elimination warmup any more
Fixed an unknown problem (I could just see the code was wrong)

New in Beta 8:
Removed white flags in missionpack/ctfelimination
Added 3 new modes to LMS, use cvar g_lms_mode [0-3].
Client prints LMS mode in right cornor if scoreboard showing
No longer does anything in intermission in any gametype. Hopefully this will solve a problem with no-humans play.
new UI from svn (LMS now a FFA gametype)

New in Beta 7:
Possible fixed a bug in Missionpack if it is compiled as a shared module (might not work but its worth a try and makes the code more effective)
Added personal scores to Double Domination
Removed Whiteflags and persistant powerups from Double Domination (The removal of the powerups might be discussed)
Can no longer score in Double Domination after time has run out
Some UI things from SVN (I don't really know what)
The Domination Point B is now a BFG ammo if not taken (not really a change)
Some other things I have forgotten

New in Beta 6:
Fixed sounds in CTF Elimination
Bots no longer select a team leader in LMS
Fixed a serius Missionpack bug (Signal 11)
Changed respawning times in new gametypes
Added a version of Double Domination as gametype 11. No bot support yet! 

New in Beta 5:
Fixed a Railgun pickup bug in Instantgib/CTF Elimination
Added gametype Last Man Standing (LMS)
Added CTF Elimination and LMS to the create server screen
New arenas.txt file, addes the existing 0.70 maps to the gametypes

New in Beta 4:
New gametype: CTF Elimination
New gametype template: Last Man standing
Elimination teams change sides after each round, allowing unbalanced maps.
Taunts after elimination
Code: Added varaibles: 
int g_ffa_gt      if this is 1, the game is FFA even if it has a high gametype number
int cgs.ffa_gt	  same, but in cgame. Remember to change CG_ParseServerinfo in cg_servercmds.c to set this from gametype
I haven't touched the UI since Beta 2, so you can't see the new gametypes there

New in beta 3:
g_instantgib is now a LATCH CVAR, map_restart required
everything is now laoded in instantgib, so nothing bad happens if it is suddently disabled
added CVAR g_regen
added instantgib with gauntlet (from OA svn)

New in beta 2:
Instantgib can be enabled in all gamemodes
Vampire can be enabled in all gamemodes
Colorfull timer
No free point to first team
Free spectator when dead
Elimination is now gametype 8
Default CVAR values changed
Correct update of the scores in the corner

Then starting a dedicated server, remember to include "+set fs_game oaxB44", like in this example:
./openarena.i386 +set dedicated 2 +set fs_game oaxB44 +g_gametype 8 +map oasago2

Also feel free to change/add 'seta sv_dlURL=http://brie.ostenfeld.dk/~poul19' in q3config.cfg on your server. This will allow faster download for the clients.
