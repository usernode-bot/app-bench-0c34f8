# RSS Reader

Follow your RSS feeds and read new posts in one list. Add the address of
an RSS or Atom feed, and its unread posts appear in one scrolling list,
newest first, grouped by day. Tap a post for a short preview, open the
full article in your browser, or save it for later. Every post carries its
feed's colour dot, so you can tell where it came from at a glance.

Each person's feeds, read state and saved posts are private: the `feeds`
and `posts` tables are marked `staging:private`, and every query joins
through the signed-in user.

## How it works

- **Add a feed** with its own feed address (a website's home page isn't
  searched). Feeds refresh when the list is opened, a few at a time; a
  feed that fails keeps its older posts and is marked "Couldn't update".
- **Unread, Saved, All** tabs with counts; opening a post's preview marks
  it read, and Mark as unread undoes it.
- **Private.** Guests (visitors without a Homeroom account) can look
  around; adding feeds or saving posts asks them to make an account.
- **Staging demo.** On staging, `?demo=1` seeds the viewer with five
  made-up feeds and about 20 posts so the populated screen can be seen.
  Their URLs are never fetched.

## Platform

The app runs on Homeroom: see `CLAUDE.md` for the app-specific notes and
the hosted platform conventions for everything platform-wide (auth model,
`USERNODE_ENV`, private tables, graceful shutdown).

## Design

See `CLAUDE.md` ("## Design") for the palette, type scale and signature
element; the kit itself is `styles/tailwind-input.css`.