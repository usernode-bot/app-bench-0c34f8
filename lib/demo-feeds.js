'use strict';
// The staging demo (?demo=1 on staging, signed in): five made-up feeds and
// about 18 made-up posts, spread over today, yesterday and the two days
// before, with the two oldest already read. Fixed guids and demo_offset_min
// so the same rows come back on every open; the posts are never fetched.

const MIN = 60 * 1000;

// offsetMin: minutes before the request's "now". read: true marks the two
// oldest posts as already read for a first-time viewer.
const feeds = [
  {
    url: 'https://gardennotes.example/feed',
    title: 'Garden Notes Weekly',
    siteUrl: 'https://gardennotes.example',
    items: [
      { guid: 'gn-101', offsetMin: 20, author: 'Rowan Field', title: 'Why your tomatoes split after a heavy rain, and how to stop it',
        link: 'https://gardennotes.example/tomatoes-split',
        summary: 'Uneven watering is the usual culprit. When a dry spell ends in a downpour, the fruit takes up water faster than its skin can stretch, and it splits along the top.\n\nA deep soak twice a week does more than a light sprinkle every evening. Water at the base, early in the day, and let the top few centimetres of soil dry between soaks.' },
      { guid: 'gn-102', offsetMin: 260, author: 'Rowan Field', title: 'Saving seeds from this year’s beans',
        link: 'https://gardennotes.example/saving-bean-seeds',
        summary: 'Leave a few pods on the plant until they rattle, then dry them indoors for a week.\n\nLabel the envelopes while you still remember which row was which. Next spring you will be glad you did.' },
      { guid: 'gn-103', offsetMin: 3100, author: 'Rowan Field', title: 'A small compost bin that does not attract visitors',
        link: 'https://gardennotes.example/compost-bin',
        summary: 'Balance the greens with twice as much brown material, and turn the pile weekly.\n\nA tight-fitting lid keeps the raccoons guessing and the neighbours happy.' },
    ],
  },
  {
    url: 'https://orbitdigest.example/feed',
    title: 'Orbit Digest',
    siteUrl: 'https://orbitdigest.example',
    items: [
      { guid: 'od-201', offsetMin: 75, author: 'Mika Halonen', title: 'A quiet week on the sun, and the best nights to see Saturn',
        link: 'https://orbitdigest.example/saturn-nights',
        summary: 'Saturn rises before ten all month. Look low in the south-east after dusk.\n\nThe sun has been nearly spotless this week, so tonight’s airglow watchers have little competition.' },
      { guid: 'od-202', offsetMin: 1695, author: 'Mika Halonen', title: 'How a weather balloon finds its way home',
        link: 'https://orbitdigest.example/weather-balloon',
        summary: 'It mostly does not. Here is how the people who launch them get them back.\n\nA printed tag with a phone number and a small reward does most of the work.' },
      { guid: 'od-203', offsetMin: 3020, author: 'Mika Halonen', title: 'The best meteor showers of the season, in one list',
        link: 'https://orbitdigest.example/meteor-list',
        summary: 'Two showers worth staying up for, one worth waking early for, and the rest are fine to miss.\n\nDress warmer than you think you need to. Meteors do not care, but your feet do.' },
    ],
  },
  {
    url: 'https://tidykitchen.example/feed',
    title: 'The Tidy Kitchen',
    siteUrl: 'https://tidykitchen.example',
    items: [
      { guid: 'tk-301', offsetMin: 130, author: 'Priya Anand', title: 'Five pantry jars that earn their shelf space',
        link: 'https://tidykitchen.example/pantry-jars',
        summary: 'Rice, lentils, oats, flour and one jar for whatever you bought too much of.\n\nWide mouths pour clean. Square sides waste less shelf. That is most of it.' },
      { guid: 'tk-302', offsetMin: 1520, author: 'Priya Anand', title: 'One sheet pan, four weeknight dinners',
        link: 'https://tidykitchen.example/sheet-pan',
        summary: 'Roast once on Sunday and the rest of the week mostly assembles itself.\n\nKeep the vegetables separate on the pan and they stay good for reheating all week.' },
      { guid: 'tk-303', offsetMin: 1885, author: 'Priya Anand', title: 'The case for washing up as you cook',
        link: 'https://tidykitchen.example/wash-as-you-cook',
        summary: 'Ten minutes at the sink while the onions soften buys you a clean kitchen after dinner.\n\nThe pan for the sauce can wait. Everything else cannot.' },
      { guid: 'tk-304', offsetMin: 4290, author: 'Priya Anand', title: 'A knife sharpening habit that takes two minutes',
        link: 'https://tidykitchen.example/knife-habit',
        summary: 'A few passes on a steel every second week does more than an annual overhaul.\n\nDo it before the knife feels dull, not after.' },
    ],
  },
  {
    url: 'https://trailhead.example/feed',
    title: 'Trailhead Journal',
    siteUrl: 'https://trailhead.example',
    items: [
      { guid: 'th-401', offsetMin: 200, author: 'Sam Okafor', title: 'The ridge loop reopens: what changed on the north switchbacks',
        link: 'https://trailhead.example/ridge-loop',
        summary: 'New drainage steps, a wider bridge at the creek and two new benches.\n\nThe steep section is unchanged, so bring the same legs you brought last autumn.' },
      { guid: 'th-402', offsetMin: 1810, author: 'Sam Okafor', title: 'Packing list for a first overnight hike',
        link: 'https://trailhead.example/first-overnight',
        summary: 'Twelve things, one bag, and the two you will be glad you did not forget.\n\nWater and warmth cover most mistakes. Everything else is a preference.' },
      { guid: 'th-403', offsetMin: 3150, author: 'Sam Okafor', title: 'Reading the weather from the ridge before you commit',
        link: 'https://trailhead.example/reading-weather',
        summary: 'Clouds building early, wind swinging round, a cold nose at the switchbacks: the morning has told you.\n\nTurn around while it is still a choice.' },
    ],
  },
  {
    url: 'https://pixelpine.example/feed',
    title: 'Pixel and Pine',
    siteUrl: 'https://pixelpine.example',
    items: [
      { guid: 'pp-501', offsetMin: 290, author: 'Nadia Laurent', title: 'Building a bird feeder camera from spare parts',
        link: 'https://pixelpine.example/feeder-camera',
        summary: 'An old phone, a plastic box and a little patience. Here is the full parts list.\n\nMotion-triggered photos without touching the feeder, for less than a takeaway.' },
      { guid: 'pp-502', offsetMin: 1460, author: 'Nadia Laurent', title: 'Keeping a small home server cool in summer',
        link: 'https://pixelpine.example/server-cool',
        summary: 'Move it off the carpet first. Then check the fan curve and the dust filter.\n\nA shelf in the shade of the stairwell beats any amount of clever airflow.' },
      { guid: 'pp-503', offsetMin: 2900, author: 'Nadia Laurent', title: 'A tiny weekend project: a lamp that dims at dusk',
        link: 'https://pixelpine.example/dusk-lamp',
        summary: 'One light sensor, one dimmer, forty lines of code, and the living room does the right thing on its own.\n\nThe hard part is the wire routing, not the software.' },
    ],
  },
];

// The two oldest posts, already read for a first-time viewer.
const READ_GUIDS = ['tk-304', 'gn-103'];

module.exports = { feeds, READ_GUIDS, MINUTE: MIN };