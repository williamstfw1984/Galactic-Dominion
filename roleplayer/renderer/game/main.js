"use strict";
/* Galactic Dominion: start-up. The game opens on the connect screen: host a new game, join one, or return to one. */
(function () {
  const GD = window.GD;
  // A seat to return to can be named in the address (game.html#<server>|<token>), so the host's window can reopen it.
  const hash = decodeURIComponent(location.hash.slice(1));
  const at = hash.indexOf("|");
  if (at > 0 && /^http:\/\//.test(hash)) {
    GD.base = hash.slice(0, at); GD.token = hash.slice(at + 1); GD.hosting = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(GD.base + "/");
    GD.loadStore();
    GD.loadRules().then(GD.enter).catch(GD.connect);
  } else GD.connect();
})();
