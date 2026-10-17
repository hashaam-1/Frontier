Music for Sound design
======================

Frontier never ships music. Put tracks you have the rights to here:

    assets/music/<style name>/     for one style only  (e.g. assets/music/documentary/)
    assets/music/                  for every style

With Options -> Sound design ticked, one track plays under the whole video: it fades
in and out and dips every time the narrator speaks. mp3, wav, m4a, ogg and flac work.
How loud it sits is set in the style file under "look": {"sound": {...}}:

    "music_db": -18     the music's level in the gaps
    "duck_db": -8       how far it dips under the voice
    "sfx_db": -19       the sound effects
    "music": false      no music at all for this style
