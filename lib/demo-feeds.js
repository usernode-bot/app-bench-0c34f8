// The staging demo: four plainly invented feeds and 24 posts, shown only on
// a staging preview opened with ?demo=1. Every name, person, place and site
// except example.com is made up.

// age is in minutes before the moment the demo is seeded.
const FEEDS = [
  {
    url: 'https://example.com/staging-demo/garden.xml',
    title: 'Example Garden Weekly',
    siteUrl: 'https://example.com/garden',
    posts: [
      { guid: 'garden-demo-1', title: 'Why the tomatoes on the test plot ripened two weeks early', author: 'Pat Example', age: 120,
        summary: 'Our pretend allotment had a warm spell in late summer, and the tomatoes along the south fence turned red a full fortnight ahead of the rest. We kept notes on soil, shade and watering to work out why.\n\nThe short version: the fence held the afternoon heat, and the plants there were watered less often. In this made-up post we look at what that means for next year\'s planting plan.' },
      { guid: 'garden-demo-2', title: 'Mulch, compost or leaves: what our fake allotment tested this spring', author: 'Rowan Sample', age: 420,
        summary: 'Three beds, three mulches, one made-up spring. The leaf-mould bed held water longest, the compost bed came up fastest, and the straw bed hosted an impressive population of imaginary slugs.\n\nWe would still mulch with leaves again, if only for the quiet.' },
      { guid: 'garden-demo-3', title: 'Saving seeds from beans you never planted', author: 'Pat Example', age: 1560,
        summary: 'A neighbour left a pod of dried beans on our gate last autumn, so we planted the ones that rattled. This post is about what came up, which was mostly nothing, and the two plants that behaved as if they had read the manual.' },
      { guid: 'garden-demo-4', title: 'A rain gauge made from a jam jar tells you less than you hope', author: 'Inch Sample', age: 2300,
        summary: 'We measured a month of made-up weather with a jam jar, a ruler and far too much confidence. The totals disagreed with the imaginary weather service by a factor the weather service would call "some".' },
      { guid: 'garden-demo-5', title: 'The greenhouse door that only opens in August', author: 'Rowan Sample', age: 3100,
        summary: 'Every pretend garden has one mystery. Ours is a door that swells shut from October to July, then swings freely for four weeks. We have stopped fighting it and started planning the season around it.' },
      { guid: 'garden-demo-6', title: 'Five soups you can make with one sample onion', author: 'Inch Example', age: 4400,
        summary: 'The sample onion went a long way this week. Five made-up soups, in order of how much they tasted of onion: not very, a bit, noticeably, mostly, and entirely.' },
    ],
  },
  {
    url: 'https://example.com/staging-demo/transit.xml',
    title: 'Pretend Transit Blog',
    siteUrl: 'https://example.com/transit',
    posts: [
      { guid: 'transit-demo-1', title: 'The night bus that only runs on leap years, explained', author: 'Alex Sample', age: 180,
        summary: 'Once every four years, the N-29 appears on the timetable of our imaginary city and carries eleven passengers across town at 2am. We rode it in theory and asked the made-up drivers what it is for.\n\nNobody agreed, which is how you know a route is loved.' },
      { guid: 'transit-demo-2', title: 'New timetable for the imaginary harbour ferry', author: 'Robin Placeholder', age: 540,
        summary: 'From next month the pretend ferry leaves every twenty minutes instead of every half hour, which the sample timetable office says will change nothing except the waiting.' },
      { guid: 'transit-demo-3', title: 'Tram line 0 gets a second stop, in theory', author: 'Alex Sample', age: 1620,
        summary: 'Line 0 has run between the depot and the depot for as long as anyone has pretended to remember. The proposed second stop, "Halfway", has drawn two letters to the sample paper, both in favour.' },
      { guid: 'transit-demo-4', title: 'What the platform clock is actually for', author: 'Robin Sample', age: 2450,
        summary: 'A study of one made-up station suggests the clock is not for catching trains, which leave when they leave, but for agreeing on how late to be. On this we can all set our watches.' },
      { guid: 'transit-demo-5', title: 'The escalator that only plays music on the way up', author: 'Alex Placeholder', age: 3250,
        summary: 'Our pretend metro plays a short tune on the up escalator and nothing on the down one. The operator says this is not a metaphor, but has declined to say what it is instead.' },
      { guid: 'transit-demo-6', title: 'Cycling the length of the sample ring road in one afternoon', author: 'Robin Example', age: 4560,
        summary: 'Eleven miles of made-up tarmac, one flapjack, and a headwind that exists only on the northern half. A ride report with no surprises, which is the nicest kind.' },
    ],
  },
  {
    url: 'https://example.com/staging-demo/kitchen.xml',
    title: 'Sample Kitchen',
    siteUrl: 'https://example.com/kitchen',
    posts: [
      { guid: 'kitchen-demo-1', title: 'Five soups you can make with one sample onion', author: 'Sam Example', age: 300,
        summary: 'This week the sample kitchen had exactly one onion and a shelf of questions. The soups, from least to most onion-forward, are written up here with made-up quantities you should not trust.' },
      { guid: 'kitchen-demo-2', title: 'Bread that rises overnight, a sample recipe', author: 'Jamie Placeholder', age: 960,
        summary: 'Mix it before bed, bake it after breakfast. The dough does the work while the sample kitchen sleeps, and the made-up crumb comes out better for the waiting.' },
      { guid: 'kitchen-demo-3', title: 'Pickling anything in a sample jar', author: 'Sam Placeholder', age: 2760,
        summary: 'The rule we invented: if it fits in the jar, it can be pickled. Results ranged from excellent (made-up radish) to instructive (grapes, of which we will say no more).' },
      { guid: 'kitchen-demo-4', title: 'The kettle test: how a made-up tea shop judges its water', author: 'Jamie Sample', age: 3540,
        summary: 'Too hot and the sample green tea goes bitter; too cool and it goes thin. The pretend shop checks the kettle against a thermometer that lives on a ribbon by the till.' },
      { guid: 'kitchen-demo-5', title: 'A pancake for every day of a pretend week', author: 'Sam Sample', age: 4180,
        summary: 'Seven batters, Sunday to Saturday, none of them requiring anything you do not already have in an imaginary pantry. The Tuesday one is the keeper.' },
      { guid: 'kitchen-demo-6', title: 'What to do with the last spoonful of sample jam', author: 'Jamie Example', age: 4900,
        summary: 'Stir it into yoghurt, melt it into porridge, or eat it standing at the fridge like everyone else. This post is mostly permission.' },
    ],
  },
  {
    url: 'https://example.com/staging-demo/space.xml',
    title: 'Made-up Space News',
    siteUrl: 'https://example.com/space',
    posts: [
      { guid: 'space-demo-1', title: 'A pretend probe sends back its first blurry photo of a moon', author: 'Nova Example', age: 240,
        summary: 'The sample orbiter\'s first image arrived out of focus, upside down, and better than anyone had hoped. Mission control, which does not exist, declared the calibrating phase of its pretend mission a success.' },
      { guid: 'space-demo-2', title: 'How long does a placeholder comet tail really get?', author: 'Orion Sample', age: 1020,
        summary: 'Longer than you think, shorter than the diagrams. We measure the made-up comet\'s tail in bus lengths, because the sample press office insists on units people can picture.' },
      { guid: 'space-demo-3', title: 'A practice launch window, and what we would pack', author: 'Nova Placeholder', age: 2820,
        summary: 'If the imaginary rocket leaves on Tuesday, the pretend crew takes: two cameras, one book each, and the sample fruit cake that has now flown three missions without being eaten.' },
      { guid: 'space-demo-4', title: 'The crater on our placeholder moon that looks like a kettle', author: 'Orion Placeholder', age: 3660,
        summary: 'It is not a kettle. It has never been a kettle. But once the sample newsletter pointed out the spout, nobody could unsee it, and now the made-up maps mark it "Kettle".' },
      { guid: 'space-demo-5', title: 'Why the imaginary telescope naps at noon', author: 'Nova Sample', age: 4440,
        summary: 'Heat, mostly. The pretend observatory closes its mirrors for the hottest hour, and the sample operators use the time to argue about lunch.' },
      { guid: 'space-demo-6', title: 'Reading the sample star chart without a degree in pretend astronomy', author: 'Orion Example', age: 5100,
        summary: 'Start with the bright one, work outwards. Our made-up guide to the night sky assumes nothing, costs nothing, and gets the sample constellations right about half the time.' },
    ],
  },
];

module.exports = { FEEDS };