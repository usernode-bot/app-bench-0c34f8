'use strict';

/* The sample feed (every environment, on request) and the staging demo
 * (staging only, ?demo=1 only).
 *
 * All text here is everyday, family-safe content written for this app, and
 * every seeded row is obviously fake: the demo feeds are named
 * "Staging demo: …" and the sample feed is "Sample feed: …".
 */

/* The approved built-in demo feed of sample posts. Offered as
 * "Try the sample feed" on the empty screen; removable like any feed. */
const SAMPLE_FEED = {
  kind: 'sample',
  url: 'sample:welcome',
  title: 'Sample feed: Getting started',
  author: 'RSS Reader',
  offsetsMinutes: [5, 20, 45, 90, 180, 300],
  posts: [
    {
      guid: 'sample-01-welcome',
      title: 'Welcome to your reader',
      paragraphs: [
        'This sample feed is here so you can try the reader before adding anything real. Tap a post to read its preview right here, and tap it again to close it.',
        'When you are ready, paste a site or feed address in the field above. A blog home page is enough; the reader finds its feed for you.',
      ],
    },
    {
      guid: 'sample-02-adding',
      title: 'Adding a feed from any site',
      paragraphs: [
        'You can paste a feed address or just a site address. The reader fetches the page, looks for its feed link, and brings in the newest posts as unread.',
        'Older posts from a newly added feed are marked read already, so a long archive does not flood your list. Only the newest ten arrive unread.',
      ],
    },
    {
      guid: 'sample-03-unread',
      title: 'How unread works',
      paragraphs: [
        'A filled dot means a post is unread; an outlined dot means you have opened it. Read posts stay in the list until you next check for new posts, so tapping one by mistake does not lose it.',
        'Change your mind? "Mark unread" in the preview puts it back.',
      ],
    },
    {
      guid: 'sample-04-checking',
      title: 'Checking for new posts',
      paragraphs: [
        'The reader checks your feeds when you open it and whenever you tap the refresh button or pull the list down. New posts appear at the top of the list with a short note.',
        'A feed checked in the last ten minutes is skipped, so reopening the app stays quick. Refresh always checks everything.',
      ],
    },
    {
      guid: 'sample-05-removing',
      title: 'Removing a feed you don’t need',
      paragraphs: [
        'Tap a feed chip to see what you can do with it: copy its address, open its site, or remove it. Removing asks once, because the feed’s posts leave your list too.',
        'You can always add it back later.',
      ],
    },
    {
      guid: 'sample-06-full-article',
      title: 'Opening the full article',
      paragraphs: [
        'Previews show the text the feed itself provides. When a post is worth your whole attention, "Open full post" opens the article in your browser.',
        'That is everything this sample feed wants to show. Remove it whenever you like.',
      ],
    },
  ],
};

/* The four staging demo feeds for ?demo=1, sixteen posts spread from
 * twelve minutes to five days old, in the voice of four small blogs. */
const DEMO_FEEDS = [
  {
    slug: 'slow-kitchen',
    title: 'Staging demo: Slow Kitchen',
    colorIndex: 1,
    author: 'Asha Rao',
    posts: [
      {
        guid: 'staging-demo-01',
        title: 'A weeknight dal that tastes like Sunday',
        minutesAgo: 38,
        paragraphs: [
          'Most dal recipes ask for an hour. This one gets there in twenty-five minutes with red lentils, a can of tomatoes and a spoonful of butter stirred in at the end.',
          'The trick is the tadka: cumin seeds, garlic and a dried chilli sizzled in hot oil and poured over just before serving. It is the step that makes a weeknight pot taste slow-cooked.',
          'Below: the full method, what to swap if you have no fresh ginger, and how long it keeps in the fridge.',
        ],
      },
      {
        guid: 'staging-demo-05',
        title: 'Five things to do with a bag of lemons',
        minutesAgo: 185,
        paragraphs: [
          'A neighbour left a carrier bag of lemons on the doorstep, which is how most of my cooking plans start. Before they wrinkle: preserved lemons in a jar, a tray of curd squares, and peels candied in syrup.',
          'The fifth thing is the simplest and the best. Squeeze the lot into an ice-cube tray, freeze, and you have lemon juice in spoon-sized blocks for the rest of the month.',
        ],
      },
      {
        guid: 'staging-demo-09',
        title: 'The case for a cheap cast-iron pan',
        minutesAgo: 1560,
        paragraphs: [
          'You do not need the famous brand. The budget pan at the hardware shop is the same lump of iron, and it sears a mushroom just as fiercely.',
          'Mine was eight units second-hand and slightly rusty. An hour with steel wool and a coat of oil in a hot oven brought it back, and it has done breakfast every weekend since.',
        ],
      },
      {
        guid: 'staging-demo-13',
        title: 'Bread that forgives you for forgetting it',
        minutesAgo: 3480,
        paragraphs: [
          'This loaf asks almost nothing of you: stir four ingredients the night before, then forget the bowl on the counter. By morning it has risen itself.',
          'Slide it into a screaming-hot pot with a lid and it comes out with a crust that crackles. It is the bread to make if you have ever been scared of bread.',
        ],
      },
    ],
  },
  {
    slug: 'night-bus-notes',
    title: 'Staging demo: Night Bus Notes',
    colorIndex: 2,
    author: 'Tom Okafor',
    posts: [
      {
        guid: 'staging-demo-02',
        title: 'Route 41 gets a new late-night timetable from November',
        minutesAgo: 130,
        paragraphs: [
          'The council has published the new schedule and the headline is a good one: buses every twenty minutes until half past midnight, instead of every forty.',
          'The last service pushes back to 1:40. Drivers I spoke to at the depot say the extra relief run should end the ten-minute gaps that made Friday nights a lottery.',
        ],
      },
      {
        guid: 'staging-demo-06',
        title: 'Riding every tram line in one day',
        minutesAgo: 540,
        paragraphs: [
          'Six lines, one day pass, and a notebook. I boarded the first tram at seven and stepped off the last at nine in the evening, having seen the whole network out a window.',
          'The verdict: line three has the best views, line five the strangest announcements, and the interchange at Central is still a fifteen-minute walk no timetable admits to.',
        ],
      },
      {
        guid: 'staging-demo-10',
        title: 'What the new contactless fares mean for commuters',
        minutesAgo: 3120,
        paragraphs: [
          'Tap the same card all week and the system now stops charging after the daily and weekly caps, which most riders will reach by Wednesday without noticing.',
          'The small print worth knowing: switching cards mid-week resets the weekly cap, and paper tickets cost more per ride than they did last month.',
        ],
      },
      {
        guid: 'staging-demo-14',
        title: 'The night bus that runs only on Fridays',
        minutesAgo: 7300,
        paragraphs: [
          'One service a week leaves the terminal at 1:15 in the morning and threads the suburbs nobody serves after dark. Regulars call it the lantern.',
          'It is the bus for cleaners, kitchen staff and anyone whose Friday ends later than everyone else’s. The driver knows every stop by the people who wait there.',
        ],
      },
    ],
  },
  {
    slug: 'field-guide-weekly',
    title: 'Staging demo: Field Guide Weekly',
    colorIndex: 3,
    author: 'Mari Lind',
    posts: [
      {
        guid: 'staging-demo-03',
        title: 'First swifts of the autumn spotted over the estuary',
        minutesAgo: 65,
        paragraphs: [
          'A reader counted eleven birds screaming low over the water on Tuesday evening, the first gathering of the season. They feed hard now before the long flight south.',
          'If you want one last good look, stand near the reed bed at dusk. They pour down the estuary in loose chains and are gone by the end of the month.',
        ],
      },
      {
        guid: 'staging-demo-07',
        title: 'How to tell a willow warbler from a chiffchaff',
        minutesAgo: 420,
        paragraphs: [
          'By sight these two are almost twins, which frustrates every beginner. Listen instead: one sings its own name, chiff-chaff, two notes down the scale.',
          'The willow warbler pours out a long, silvery descending trickle. Legs are the other clue, pale on the willow, dark on the chiffchaff, though you rarely get close enough to trust them.',
        ],
      },
      {
        guid: 'staging-demo-11',
        title: 'Starling murmurations: where to watch this month',
        minutesAgo: 2040,
        paragraphs: [
          'The roost sites have settled for the season and the evening displays are running long. Reeds by the water works are drawing several thousand birds at sunset.',
          'Arrive half an hour before dusk, stand with the light behind you, and wait for the moment the whole flock turns at once and the sky goes quiet.',
        ],
      },
      {
        guid: 'staging-demo-15',
        title: 'A quiet hour at the reservoir hide',
        minutesAgo: 4440,
        paragraphs: [
          'Nothing rare turned up, which is its own kind of morning: a heron fishing in plain view, teal asleep on the mud, and a kingfisher that stayed just long enough to be believed.',
          'The warden has refitted the west hide with lower windows for children. It is the best seat in the reserve now, whatever the day brings.',
        ],
      },
    ],
  },
  {
    slug: 'plain-text-web',
    title: 'Staging demo: Plain Text Web',
    colorIndex: 4,
    author: 'Jun Park',
    posts: [
      {
        guid: 'staging-demo-04',
        title: 'Why our pages load in under a second on a train',
        minutesAgo: 12,
        paragraphs: [
          'No web fonts, no tracking scripts, one small stylesheet. On a moving train with two bars of signal, that is the difference between reading a page and watching it fail.',
          'The whole site weighs less than one photo from a normal blog. Text first is not nostalgia; it is what the last mile of the network can actually carry.',
        ],
      },
      {
        guid: 'staging-demo-08',
        title: 'Dark mode without the flash: a small fix',
        minutesAgo: 300,
        paragraphs: [
          'Dark pages used to flash white for a moment on load, because the browser painted before the stylesheet arrived. The fix was three lines of inline style in the document head.',
          'Set the background colour in the HTML itself and the flash is gone, even on the slowest connection. Small fix, big effect on the eyes at midnight.',
        ],
      },
      {
        guid: 'staging-demo-12',
        title: 'Notes from rewriting our RSS feed by hand',
        minutesAgo: 1800,
        paragraphs: [
          'The generator had been emitting dates in the wrong format for a year, and no reader complained loudly enough for me to notice. So I wrote the feed by hand.',
          'It is forty lines of XML and a build step. Dates validated, titles clean, every post included. Sometimes the tool was the problem and a text editor is the answer.',
        ],
      },
      {
        guid: 'staging-demo-16',
        title: 'Accessible tables in five steps',
        minutesAgo: 5340,
        paragraphs: [
          'One: a caption that says what the table is for. Two: table headers on real header elements, not bold text in a row. Three: no merged cells, ever.',
          'Four: mark up the row headers too, so a screen reader can walk the grid. Five: test it at twice the default text size. Most tables fail all five, and all five take an hour to learn.',
        ],
      },
    ],
  },
];

module.exports = { SAMPLE_FEED, DEMO_FEEDS };
