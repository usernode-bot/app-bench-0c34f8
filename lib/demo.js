// Staging demo data (the spec's "Staging demo" section). On staging only, a
// first ?demo=1 request writes these four made-up feeds for the viewer with
// demo=true; their posts never touch the network — demoItems() serves them
// from here, timed relative to the request's "now".

const FEEDS = [
  {
    url: 'https://garden.example.com/feed.xml',
    title: 'Example Garden Notes',
    siteUrl: 'https://garden.example.com',
    items: [
      { hoursAgo: 2, title: 'Ten tomato varieties we grew in the test beds this summer', body: 'Every spring we plant a few rows of something new beside the old favourites. This year it was tomatoes, ten kinds in all, from tiny yellow currants to a ribbed beefsteak that took until September to ripen.\n\nHere is how each one did, which ones split in the August rain, and the two we are saving seed from for next year. The currant tomato won the summer for sheer stubbornness: it shrugged off the dry fortnight and kept ripening handfuls a day. The beefsteak was glorious but wanted staking twice the height we gave it.\n\nThe lesson, as ever, is to label everything. We lost the names of two rows by July and spent the autumn guessing.' },
      { hoursAgo: 9, title: 'Why your basil keeps bolting, and what to do about it', body: 'Bolted basil is the shop-bought pot curse: it flowers, the leaves turn bitter, and by August you are buying pesto. Ours used to do it too, every year, until we changed two things.\n\nFirst, light. Basil on a windowsill in a north-facing kitchen was never going to be happy; it wants six honest hours of sun. Second, and this is the one that matters: pick it hard and pick it early. Take the top two pairs of leaves every week from the day you plant it out, and the plant branches instead of climbing.\n\nIf it has already bolted, cut it back to the lowest pair of leaves, water, and wait. Half the pots come back.' },
      { hoursAgo: 26, title: 'Compost quick wins for a small balcony', body: 'A balcony composter sounds like a thing for people with a garden. It is not: two stacked crates, a handful of worms, and your coffee grounds have somewhere to go.\n\nKeep it simple. Shred everything small, keep the mix as damp as a wrung-out sponge, and add a layer of dry leaves or shredded paper every time the kitchen scrapes a bowl in. Balance is the whole game.\n\nIn about eight weeks you will have a dark, sweet-smelling handful of the best potting soil you have ever owned, and your waste bin will smell far better too.' },
      { hoursAgo: 51, title: 'A seed order worth making in October', body: 'The seed catalogues land in October and it is easy to order like a person who owns ten acres. Here is the short list that earns its space in a small plot.\n\nBroad beans sown now come up weeks before anything you plant in spring. Garlic goes in this month and needs nothing until summer. And one packet of good cut-and-come-again salad will out-produce every bagged lettuce you would otherwise buy.\n\nSkip the exotic peppers unless you have a heated windowsill and patience. We say this every year, and every year we ignore it, and every January we eat a very small, very expensive pepper.' },
      { hoursAgo: 74, title: 'The hedge cut, and what we found in it', body: 'The annual hedge cut is the garden\'s one day of hard labour, and this year it came with discoveries: a wren\'s old nest, lost tennis ball number four, and a rose that has been quietly climbing through the privet all summer.\n\nWe cut less than we meant to and left the middle untouched, because the blackbird was still commuting through it. A hedge cut too hard becomes a fence; cut gently it stays a street of small apartments.\n\nThe rose stays. It flowers in June and the pruning can wait until it says so.' },
      { hoursAgo: 96, title: 'Water in the evening, feed in the rain: autumn tasks', body: 'Autumn gardening is mostly doing less, more carefully. Leave the seed heads standing for the finches. Stop feeding anything in a pot; they are heading for sleep, not a growth spurt.\n\nBut move the water. A bucket left under a downpipe for a fortnight collects enough for a month of dry spells, and the rain barrel beats the tap for everything except seedlings.\n\nAnd plant bulbs while the soil is still warm. It feels wrong to bury things that look fine, but that is the whole trick of next spring.' },
    ],
  },
  {
    url: 'https://bikeworkshop.example.com/rss',
    title: 'Demo Bike Workshop',
    siteUrl: 'https://bikeworkshop.example.com',
    items: [
      { hoursAgo: 3, title: 'How to true a wheel with nothing but a spoke key', body: 'A wobble you can see from the saddle is usually two or three loose spokes, not a bent rim. Here is the slow, patient way to find them and bring the rim back.\n\nSpin the wheel and watch the gap to the brake block. Where it closes, that is your loose side. A quarter turn at a time on the spoke directly opposite the rub, and check again after every turn. It is dull work and it works.\n\nIf a spoke turns freely and does nothing, the nipple is stripped or the spoke is snapped, and that is a wheel-off job. Everything else is ten minutes and a cup of tea.' },
      { hoursAgo: 5, title: 'A weeknight maintenance routine for winter commuters', body: 'Ten minutes on a Friday evening beats an hour in the dark on a Monday morning, and it saves your chain.\n\nWipe the chain with a rag until the rag stops coming away black, then oil the rollers, not the outside. Check the tyres for anything embedded before it works its way in. Squeeze the brakes and look at the pads: if the grooves are gone, the pads are done.\n\nThat is it. Lights charged, chain wiped, tyres looked at. Do it weekly and the bike carries you all winter without complaint.' },
      { hoursAgo: 30, title: 'Winter tyres: are they worth it for a commute?', body: 'We rode the same hill on three sets of tyres through a wet week: the summer race tyres, a all-season touring pair, and a studded set borrowed from a reader in Finland.\n\nThe touring tyres were the honest winner. Slower on the flats by a hair, and entirely unbothered by painted lines, drain covers and the leaf slick under the railway bridge. The race tyres skipped like stones. The studs were superb on the one icy morning and droning on the other four.\n\nIf your commute has one bad stretch, buy one good touring tyre for the front. It is the wheel that steers and the one that slips first.' },
      { hoursAgo: 53, title: 'The cheapest upgrade is a saddle at the right height', body: 'Half the discomfort we see at the workshop is not the bike. It is a saddle a centimetre too low, or a seatpost slipped down from somebody shorter last weekend.\n\nThe quick check: sit on the saddle, put your heel on the pedal at its lowest point, and your leg should be straight. Clip in or press the ball of your foot on the pedal and your knee should have a slight bend.\n\nRaise it, ride to the corner and back, and adjust a few millimetres at a time. It costs nothing and it is the difference between riding home smiling and not riding at all.' },
      { hoursAgo: 100, title: 'Brake bleed day at the workshop: what we learned', body: 'Twelve bikes came through brake bleed day, and every single one rode out with a lever that actually stops the bike. The moral is that hydraulic brakes are not magic, they are just fussy.\n\nThe mess is the barrier, not the skill. Syringes, a bottle of the right fluid, a block of wood the right thickness, and an old towel you have made peace with losing.\n\nTwo of the twelve needed nothing but a pad reset and a tighten of the lever clamp. Check that before you buy fluid: a lever that travels too far to the bar is often just a cable stretch.' },
    ],
  },
  {
    url: 'https://kitchenjournal.example.com/atom.xml',
    title: 'Sample Kitchen Journal',
    siteUrl: 'https://kitchenjournal.example.com',
    items: [
      { hoursAgo: 5, title: 'A weeknight lentil soup that tastes like it took all day', body: 'Smoked paprika, a spoon of tomato paste fried until dark, and lemon at the end. Twenty five minutes, one pot.\n\nThe trick is the paste: let it catch on the base of the pot and go a shade darker before the stock goes in. That minute is the difference between brown soup and deep soup.\n\nRed lentils need no soaking and break down on their own, which is what thickens it. Finish with the juice of half a lemon and taste before you add salt; the lemon does more of the work than you expect. Bread compulsory.' },
      { hoursAgo: 20, title: 'Roast a tray of veg on Sunday, eat well all week', body: 'One tray, whatever the market had, and a hot oven: the whole week of lunches sorted before the week starts.\n\nCut everything to cook at the same speed. Roots in one-centimetre dice, onions in wedges, and the soft things, courgette and peppers, in bigger pieces so they survive. Oil, salt, thyme, two hundred and twenty degrees until the edges catch.\n\nFrom there it is a salad, a soup, a frittata, or a pile beside whatever you were having anyway. It is the rare plan that survives Wednesday.' },
      { hoursAgo: 44, title: 'The case for cooking beans from dried', body: 'A bag of dried beans costs a third of the tins and tastes twice as good, and the only real price is thinking ahead.\n\nSoak overnight, simmer with a bay leaf and half an onion, and salt the water early, contrary to everything you were told. Beans salted from the start season evenly; beans salted at the end taste of nothing until the very edge.\n\nA big batch freezes in its own liquid, which is the part worth more than the beans. That liquid is the base of next week\'s soup, and it costs nothing.' },
      { hoursAgo: 70, title: 'Brown butter, and the four things it improves', body: 'Brown butter is not a technique so much as a small act of patience: butter in a light pan, medium heat, until the milk solids at the edge go hazelnut.\n\nIt improves four things more than any other: sage anything, a plain sponge, roast carrots, and Sunday pancakes.\n\nThe failure mode is walking away. It goes from nutty to burnt in under a minute, and the smell tells you first. Stay at the pan and it is the easiest luxury in the kitchen.' },
      { hoursAgo: 90, title: 'Stock from scraps: the honest version', body: 'The internet\'s stock-from-scraps fantasy is a bag of peelings becoming a rich consomme. The honest version is quieter: vegetable peelings, a bay leaf, water, and ninety minutes makes a light stock better than any cube.\n\nKeep a bag in the freezer for onion ends, carrot peelings and celery tops. Never potato skins, which go cloudy, and go easy on the brassicas, which make the whole pot smell of a school canteen.\n\nSimmer, never boil, and strain. It will not change your life. It will improve the rice.' },
    ],
  },
  {
    url: 'https://skyweekly.example.com/feed',
    title: 'Test Sky Weekly',
    siteUrl: 'https://skyweekly.example.com',
    items: [
      { hoursAgo: 8, title: 'What to look for in the night sky this month', body: 'Saturn is still high after dark, and the Orionids peak on the 21st. A short guide for anyone with a pair of binoculars.\n\nFind Saturn first: it is the steady, buttery point of light that does not twinkle, southeast and halfway up at ten. Even small binoculars show it is not a point. Jupiter rises later and brighter and is worth staying up for.\n\nThe Orionids are swift and often bright, and you do not need to look at Orion to see them; face any dark patch of sky after midnight and give your eyes twenty minutes. No phone.' },
      { hoursAgo: 32, title: 'Why the Moon looks different every night, in one diagram', body: 'The Moon is doing the same thing every month: travelling around us with the sun on one fixed side of it. What changes is how much of the lit half we happen to see.\n\nWaxing means the lit edge grows on the evening side; waning means it shrinks on the morning side. A crescent low in the west after sunset and a crescent low in the east before sunrise are the same crescent seen from either end of the night.\n\nOnce that clicks, the whole calendar of phases stops being a memorisation task and becomes a walk around a circle.' },
      { hoursAgo: 57, title: 'A cheap telescope is worse than good binoculars', body: 'The first telescope most people buy is the one that puts them off the hobby: shaky tripod, tiny optics, a moon that wobbles out of view every time you touch the focuser.\n\nGood binoculars beat them all. A steady 10x50 shows the craters of the Moon, the moons of Jupiter, and more stars than you can count, and it doubles as the thing you take birdwatching.\n\nIf you must have a telescope, spend on the mount, not the tube. A wobbly view of a good mirror is worth less than a steady view of a modest one.' },
      { hoursAgo: 82, title: 'The star that is not a star: planets vs stars, plainly', body: 'Twinkle is the whole test. Stars are so far away they are points of light, and our atmosphere shivers those points. Planets are close enough to be tiny discs, and a disc does not twinkle.\n\nSo: the bright light that is steady tonight is a planet. The bright light that flickers red and green, especially low in the sky, is a star, and its colours are the atmosphere splitting its light, not distress or UFOs.\n\nBright and steady and visible at sunset in the west is Venus, and it is the most-photographed "mysterious object" of every month.' },
      { hoursAgo: 105, title: 'October meteors: how to actually see some', body: 'Meteor showers are advertised as if the sky throws fireworks. The truth is calmer: you lie down, you get warm, you wait, and then you win.\n\nThe rules that matter are heat, dark and time. A reclining chair, a blanket and a hot drink beat any telescope. Get away from the streetlight, face away from the Moon if it is up, and give it half an hour minimum, because your eyes need the first twenty.\n\nExpect a handful an hour from a modest shower, one every few minutes from a good one, and remember every single one you catch is a grain of comet dust hitting the air above you at forty kilometres a second.' },
    ],
  },
];

const TOTAL_ITEMS = FEEDS.reduce((n, f) => n + f.items.length, 0);

/** The four demo feeds as { url, title, siteUrl, demo }. */
function demoFeeds() {
  return FEEDS.map(({ url, title, siteUrl }) => ({ url, title, siteUrl, demo: true }));
}

/**
 * demoItems(url, now): the posts of one demo feed, { guid, title, link,
 * publishedAt, excerpt, preview }, times set relative to `now` (the request's
 * "now", so a preview pinned to a moment shows the right hours). Empty for a
 * url that is not one of the demo feeds.
 */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function demoItems(url, now) {
  const feed = FEEDS.find((f) => f.url === url);
  if (!feed) return [];
  const at = new Date(now).getTime();
  return feed.items.map((item) => {
    const publishedAt = new Date(at - item.hoursAgo * 3600_000).toISOString();
    const paras = item.body.split('\n\n');
    return {
      guid: `demo:${hostOf(feed.url)}:${item.hoursAgo}`,
      title: item.title,
      link: `${feed.siteUrl}/posts/${item.hoursAgo}`,
      publishedAt,
      excerpt: item.body.slice(0, 200).split('\n')[0],
      preview: paras,
    };
  });
}

module.exports = { demoFeeds, demoItems, TOTAL_ITEMS };
