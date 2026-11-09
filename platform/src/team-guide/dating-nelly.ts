import type { Guide } from "./types";

/**
 * Dating (Nelly Sudri). D314 (Tyler, 2026-11-05): three pages to start with: a welcome and who we are, getting into the tech, then
 * connecting the tools and saving bookmarks. Page 4 holds how the work runs until it is reworked. The prospect figures on page 1
 * are from the 364 VIP Matchmaking Applications in GHL as of 2026-11-05. Channel names are the workspace's own (#nelly-traige-booked
 * is spelled that way in Slack).
 */
const GHL = "https://crm.salesagency.ai/v2/location/eLfhuKEaVMlrpLm2Fz8V";

export const datingNelly: Guide = {
  slug: "dating-nelly",
  brand: { name: "Nelly Sudri", accent: "#281a39" },
  title: "Welcome to the team",
  intro: "Go through these pages in order. Your role is picked from your link; you can switch it to see the other one.",
  pages: [
    {
      id: "welcome", title: "Welcome", intro: "A note from Nelly, and who we work with.", parts: [
        { id: "welcome", title: "Welcome", sections: [
          { id: "welcome-note", title: "Welcome from Nelly", for: ["closer", "setter", "manager"],
            summary: "We're so glad you're here.",
            blocks: [
              { video: { title: "A welcome from Nelly", url: null } },
              { p: "Hi, and welcome to the team. I'm really glad you're here. The people who apply to work with me are trusting us with something personal, and you're now one of the people they'll talk to. Take these pages at your own pace, and ask in Slack whenever something isn't clear." },
              { p: "Nelly" },
            ] },
          { id: "who-we-are", title: "Who we are", for: ["closer", "setter", "manager"],
            summary: "Matchmaking and dating coaching for people who want a real relationship.",
            blocks: [
              { p: "Nelly Sudri works with people who are done with casual dating and ready for something that lasts. They find Nelly, fill out the VIP Matchmaking Application, and book a call with the team. Some want introductions to matches, some want coaching on how they date, and plenty want both." },
            ] },
          { id: "who-applies", title: "Who applies", for: ["closer", "setter", "manager"],
            summary: "Mostly single women in their 30s who want to get married.",
            blocks: [
              { p: "From the 364 applications so far:" },
              { list: [
                "Most are in their 30s (222). Another 75 are in their 40s, and 60 are under 30.",
                "Almost all are single (302) or divorced (54). Most have no children (290).",
                "Most want marriage and a life partner (299). Another 47 want a serious, committed relationship.",
                "The problem they name most is meeting quality, relationship-minded men (219). Next is attracting men who aren't ready to commit (72), then choosing the wrong partners (35).",
                "Most ask to be considered for matchmaking introductions (272). 79 want matchmaking and coaching together.",
                "They have real careers: nurses, attorneys, pharmacists, consultants, founders, flight attendants. Most earn between $50,000 and $250,000 a year.",
                "The most applications come from Los Angeles, then Miami and the New York area. Some come from as far as Toronto and Dubai.",
              ] },
            ] },
        ] },
      ],
    },
    {
      id: "tech", title: "Your tech", intro: "Get into your accounts first. Everything after this depends on it.", parts: [
        { id: "accounts", title: "Your accounts", sections: [
          { id: "work-email", title: "Your work email", for: ["closer", "setter", "manager"],
            summary: "Everything for this job goes to your new @nellysudri.com address.",
            blocks: [
              { p: "Your work email is your name @nellysudri.com. You should have access in your personal email: look for the message with your sign-in details." },
              { steps: [
                "Find the email with your sign-in details in your personal inbox.",
                "Go to mail.google.com and sign in with your new address and the password you were sent.",
                "Set a new password when Google asks.",
                "Set up 2-step verification if Google asks for it.",
              ] },
              { note: "Every other invite (Slack, GoHighLevel, Calendly, Fathom, Zoom) is sent to your work address, not your personal one.", tone: "important" },
            ] },
          { id: "chrome-profile", title: "Make a Chrome profile for work", for: ["closer", "setter", "manager"],
            summary: "It keeps your work accounts apart from your personal ones.",
            blocks: [
              { steps: [
                "Open Google Chrome. If you don't have it, download it from google.com/chrome.",
                "Click your profile picture (or the person icon) in the top right corner.",
                "Click Add, then Sign in.",
                "Sign in with your @nellysudri.com address.",
                "Turn on sync when Chrome asks, so your bookmarks and passwords follow you to any computer.",
                "Name the profile Nelly and pick a color, so you can tell it apart from your own.",
              ] },
              { note: "Open this profile whenever you work. Every tool on the next pages is signed in here.", tone: "tip" },
            ] },
          { id: "bookmarks-bar", title: "Turn on the bookmarks bar", for: ["closer", "setter", "manager"],
            summary: "Your work links go here on the next page.",
            blocks: [
              { steps: [
                "In your work Chrome profile, press Ctrl+Shift+B (Cmd+Shift+B on a Mac).",
                "Or click the three dots in the top right, then Bookmarks and lists, then Show bookmarks bar.",
              ] },
            ] },
          { id: "invites", title: "Accept your invites", for: ["closer", "setter", "manager"],
            summary: "Accept each one from your work Chrome profile.",
            blocks: [
              { rows: [
                ["Slack", "Accept the invite and join the workspace with your work address."],
                ["GoHighLevel", "Accept the invite and set a password. Contacts, cards and call records all live here."],
              ], head: ["Tool", "What to do"] },
              { note: "Use your work address in every tool. That's how the system knows your Slack, GHL and Calendly accounts are all you.", tone: "important" },
            ] },
          { id: "invites-closer", title: "Closers also get these", for: ["closer", "manager"],
            summary: "Three more invites, for running and recording your calls.",
            blocks: [
              { rows: [
                ["Calendly", "Accept the invite to the team and sign in with Google using your work address."],
                ["Zoom", "Accept the invite. You host your calls from this account."],
                ["Fathom", "Accept the invite and sign in with Google using your work address."],
              ], head: ["Tool", "What to do"] },
            ] },
        ] },
      ],
    },
    {
      id: "setup", title: "Set up your tools", intro: "Connect everything, then save your bookmarks.", parts: [
        { id: "connect", title: "Connect your tools", sections: [
          { id: "calendly", title: "Calendly", for: ["closer", "manager"],
            summary: "Connect your work and personal calendars, then Zoom.",
            blocks: [
              { video: { title: "Connecting Calendly", url: null } },
              { steps: [
                "Sign in to Calendly from your work Chrome profile.",
                "Go to Availability, then Calendar settings, and click Connect calendar account.",
                "Connect your work Google Calendar first.",
                "Then connect your personal calendar the same way. Calendly checks both, so nobody books you over something personal.",
                "Under Add to calendar, pick your work calendar.",
                "Go to Integrations & apps, find Zoom, and click Connect.",
                "Sign in with your work Zoom account and allow access.",
                "Book a test call with yourself and check that the invite has a Zoom link.",
              ] },
              { note: "Calendly only sees when your personal calendar is busy. It doesn't see what the events are.", tone: "tip" },
            ] },
          { id: "fathom", title: "Fathom", for: ["closer", "manager"],
            summary: "Fathom records your calls and writes the notes.",
            blocks: [
              { steps: [
                "Go to fathom.video and download the desktop app for your computer.",
                "Install it and sign in with Google using your work address.",
                "Open Fathom's settings, go to Integrations, and connect Zoom.",
                "Turn on auto-record for external meetings, so every call is recorded without you having to remember.",
              ] },
            ] },
          { id: "ghl", title: "GoHighLevel", for: ["closer", "setter", "manager"],
            summary: "Three settings before you start.",
            blocks: [
              { steps: [
                "Sign in to GHL from your work Chrome profile.",
                "Open your profile settings and turn off \"Notify me about all new conversations\". Leave it on and you get a notification for every message to every contact.",
                "Connect your work Google Calendar.",
                "Connect your work email.",
              ] },
            ] },
        ] },
        { id: "bookmarks", title: "Your bookmarks", sections: [
          { id: "save-bookmarks", title: "Save these to your bookmarks bar", for: ["closer", "setter", "manager"],
            summary: "Open each one in your work Chrome profile, click the star at the right of the address bar, and choose Bookmarks bar.",
            blocks: [
              { bookmarks: [
                ["GHL Contacts", `${GHL}/contacts/smart_list/All`, "Every contact."],
                ["GHL Smart Lists", `${GHL}/contacts/smart_list/All`, "Your saved lists are the tabs along the top."],
                ["Calendly", "https://calendly.com/app/scheduled_events/user/me", "Your upcoming calls."],
                ["Fathom", "https://fathom.video/home", "Your recordings and call notes."],
                ["Gmail", "https://mail.google.com", "Your work email."],
                ["Google Calendar", "https://calendar.google.com", "Your work calendar."],
              ] },
              { note: "Your end-of-day form: the Slack bot sends you a private link. Open it the first time and bookmark it. It's yours alone, so don't share it.", tone: "important" },
              { yourLinks: true },
            ] },
        ] },
      ],
    },
    {
      id: "work", title: "How the work runs", intro: "How a call goes from booking to close, your end-of-day report, and Slack.", parts: [
        { id: "how", title: "How it works", sections: [
        { id: "what-we-do", title: "What we do", for: ["closer", "setter", "manager"],
          summary: "Two calls, two jobs.",
          blocks: [
            { rows: [
              ["Strategy session", "The first call. A 15-minute phone call to learn where they are, what they want and whether they're a fit. This is the triage call. If they fit, a closing call gets booked."],
              ["Private consultation", "The second call. A 45-minute Zoom call where the closer walks them through working with Nelly and asks for the commitment. This is the closing call."],
            ], head: ["Call", "What it's for"] },
          ] },
        { id: "booking", title: "How calls get booked", for: ["closer", "setter", "manager"],
          summary: "Every call is booked through Calendly. Nobody books calls by hand in GHL.",
          blocks: [
            { list: [
              "After the application, the lead books the Complimentary Dating Strategy Session (the triage call) themselves.",
              "If the triage call goes well, the setter books the Private Dating Consultation (the closing call) using their own setter link, so the booking is credited to them.",
              "Calendly puts the Zoom link on every closing call. If a link is missing, you'll see 🔗 on the booking in Slack and a note asking the closer to send one.",
            ] },
            { note: "Leads get their confirmation and reminder texts automatically, from Nelly. You don't need to send them.", tone: "tip" },
          ] },
        { id: "process", title: "The whole process, start to finish", for: ["closer", "setter", "manager"],
          summary: "What happens to a lead, and who does what at each step.",
          blocks: [
            { video: { title: "Walkthrough: one lead from application to close", url: null } },
            { steps: [
              "A lead fills out the application. The system tags them in GHL and gives them a card on the setter board.",
              "They book the strategy session. It's posted in #nelly-traige-booked.",
              "The setter calls them at the booked time.",
              "If they fit, the setter books the closing call with their setter link. It's posted in #nelly-calls-booked.",
              "The closer runs the consultation on the Zoom link, with Fathom recording.",
              "The recording lands in #nelly-sales-call-recording with AI notes and a score.",
              "At the end of the day, everyone files their end-of-day report. That report is what records the result in GHL.",
              "A close counts once they've signed and paid more than a deposit. Deals show up in #nelly-deal-status.",
            ] },
          ] },
        ] },
    {
        id: "calls", title: "Running your calls", sections: [
          { id: "triage-call", title: "Running a strategy session", for: ["setter", "manager"],
            summary: "A phone call through GHL. It's recorded and read automatically.",
            blocks: [
              { steps: [
                "Check #nelly-traige-booked for who's coming up. Each post shows their application answers and tags whoever the call is booked with.",
                "Call them from GHL at the booked time. GHL records and transcribes the call.",
                "If they fit, book the consultation while you're still on the phone, using your setter link.",
              ] },
              { note: "Calls under a minute don't get read, so a voicemail won't count as a conversation.", tone: "tip" },
            ] },
          { id: "closing-call", title: "Running a consultation", for: ["closer", "manager"],
            summary: "Always join through the Zoom link on the booking.",
            blocks: [
              { video: { title: "Running a consultation", url: null } },
              { steps: [
                "Find the call in #nelly-calls-booked. The post has their application answers, and you get a thread there for anything about this call.",
                "Join from the Zoom link on the booking. Don't start a new meeting.",
                "Make sure Fathom is recording.",
                "Run the call.",
              ] },
            ] },
          { id: "recording", title: "Make sure the recording is there", for: ["closer", "manager"],
            summary: "A call with no recording has no notes, no score and no proof it happened.",
            blocks: [
              { p: "The system matches a recording to the right call by who spoke and which Zoom meeting it was. That only works if:" },
              { list: [
                "you joined through the booked Zoom link (a new or instant meeting has a different meeting ID and won't match),",
                "Fathom was recording, and",
                "the client actually spoke.",
              ] },
              { p: "Within a few minutes of hanging up, check #nelly-sales-call-recording for your call." },
              { note: "If a recording comes in that the system can't place, it's posted with a Link to a contact button. A manager can link it by hand.", tone: "tip" },
            ] },
          { id: "drag", title: "Moving cards in GHL", for: ["closer", "setter", "manager"],
            summary: "You can click and drag a card to another stage. Some stages record a result when you do.",
            blocks: [
              { rows: [
                ["No Show / Cancelled", "Records the call as a no-show"],
                ["Lost", "Records that they showed and didn't buy"],
                ["Disqualified", "Records that they showed and weren't a fit"],
                ["Any other stage", "Just moves the card"],
              ], head: ["Drag to", "What happens"] },
              { note: "Only drag a card when it's true. Most of the time you won't need to: your end-of-day report moves things for you.", tone: "important" },
            ] },
        ],
      },
      {
        id: "eod", title: "Your end-of-day report", sections: [
          { id: "eod-link", title: "Your private link", for: ["closer", "setter", "manager"],
            summary: "You get your own link. Keep it to yourself: it opens your report with no login.",
            blocks: [
              { video: { title: "Filling out your end-of-day report", url: null } },
              { p: "Tyler sends you your link. Save it to your phone's home screen. It opens today's report, and you can step back to earlier days." },
              { list: [
                "Every call you had that day is listed and already filled in from the booking and the recording. Check each one and fix anything that's wrong.",
                "Your report is what writes the result into GHL. The system only suggests; what you file is what counts.",
                "If you don't file, you get a Slack DM that evening, and again the next morning, until it's done.",
                "Once you file, your day posts in #nelly-reports.",
              ] },
            ] },
          { id: "eod-closer", title: "What closers fill in", for: ["closer", "manager"],
            summary: "Each consultation, under Closing calls.",
            blocks: [
              { list: [
                "What happened on the call: closed, deposit, follow-up, lost, disqualified or no-show.",
                "Whether you pitched. A close or deposit counts as pitched on its own.",
                "Cash collected and anything you'd want the next person to know.",
              ] },
            ] },
          { id: "eod-setter", title: "What setters fill in", for: ["setter", "manager"],
            summary: "Each strategy session and dial, under Discovery calls.",
            blocks: [
              { list: [
                "Set (closing call booked), follow up, disqualified (with a reason), not interested, rescheduled or no-show.",
                "A note on the call if there's anything worth knowing.",
              ] },
            ] },
          { id: "eod-someone-else", title: "When someone else took your call", for: ["closer", "manager"],
            summary: "Hand the call to the person who actually took it, so it lands on their report.",
            blocks: [
              { p: "On the call in your report, choose Someone else took this call and pick who. It leaves your day and goes to theirs to file." },
            ] },
        ],
      },
      {
        id: "slack", title: "Slack", sections: [
          { id: "channels", title: "Which channel is for what", for: ["closer", "setter", "manager"],
            summary: "Join the channels for your role. The system posts in them; you mostly read and reply in threads.",
            blocks: [
              { rows: [
                ["#nelly-traige-booked", "Strategy sessions booked, cancelled and filed. Setters."],
                ["#nelly-calls-booked", "Consultations booked, moved and cancelled, and missing Zoom links. Everyone."],
                ["#nelly-setter-chat", "What each setter call found. Setters."],
                ["#nelly-sales-call-recording", "Each consultation's recording, notes and score. Closers."],
                ["#nelly-deal-status", "Agreements, payments and closes. Closers and managers."],
                ["#nelly-reports", "End-of-day reports, daily and weekly wrap-ups, the leaderboard. Everyone."],
              ], head: ["Channel", "What's in it, and who joins"] },
            ] },
          { id: "bot", title: "Ask the bot", for: ["closer", "setter", "manager"],
            summary: "Mention the bot in a channel or DM it, and ask in plain words.",
            blocks: [
              { p: "It can answer questions about calls, bookings and numbers, for example \"how many did we close this week?\" or \"what's our show rate this month?\". If it isn't sure, it asks you. If it can't answer, it passes the question to Tyler." },
            ] },
          { id: "reassign", title: "/reassign: hand calls to another closer", for: ["closer", "manager"],
            summary: "Out sick, or a call needs to move? Hand it over before it happens.",
            blocks: [
              { steps: [
                "Type /reassign in Slack.",
                "Pick whose calls and which day (you and today, unless you change it).",
                "Tick the calls to hand over and pick who takes them.",
              ] },
              { p: "The new closer gets the call on their report and a DM to send the client their own Zoom link. Closers can hand over their own calls; managers can hand over anyone's." },
              { note: "If Slack says this isn't turned on for this offer yet, message Tyler directly.", tone: "tip" },
            ] },
          { id: "agreement", title: "/agreement: send an agreement", for: ["closer", "manager"],
            summary: "Send the client their agreement to sign without leaving Slack.",
            blocks: [
              { list: [
                "Type /agreement and a form opens: who it's for, and which agreement.",
                "Or type it all at once: /agreement jane@example.com. An email, phone number or GHL link sends right away; a name is confirmed with you first.",
              ] },
              { p: "You'll see in Slack when it's sent, and again when it's signed." },
            ] },
          { id: "support", title: "/support: get help", for: ["closer", "setter", "manager"],
            summary: "Anything broken or confusing, in one line.",
            blocks: [
              { p: "Type /support and what's wrong, for example /support the EOD form won't load. It opens a numbered ticket and tells Tyler. Add a screenshot or a Loom in the thread after." },
            ] },
        ],
      },
      {
        id: "automatic", title: "What happens on its own", sections: [
          { id: "auto", title: "Don't do these by hand", for: ["closer", "setter", "manager"],
            summary: "The system already does these. Doing them by hand as well means doubles.",
            blocks: [
              { list: [
                "Tagging new applicants and putting them on the setter board.",
                "Confirmation and reminder texts for both calls: one when they book, one the day before, one an hour before.",
                "Creating the GHL contact, cards and call records when a call books, moves or cancels.",
                "Posting every booking, recording and deal in Slack.",
                "Writing your end-of-day answers into GHL.",
                "Writing each call's summary onto the call record and as a note on the contact.",
                "Daily, weekly and monthly wrap-ups and the weekly leaderboard.",
              ] },
              { note: "Replies to those texts come to GHL, and a person answers them there.", tone: "tip" },
            ] },
        ],
      },
      {
        id: "managers", title: "For managers", sections: [
          { id: "manager-watch", title: "What to keep an eye on", for: ["manager"],
            summary: "The things only you need to chase.",
            blocks: [
              { list: [
                "Missing Zoom links on upcoming consultations (🔗 in #nelly-calls-booked).",
                "Recordings posted with a Link to a contact button: link them to the right person.",
                "End-of-day reports not filed. Tyler is told when someone is two days behind.",
                "Calls to hand over when someone's out, with /reassign.",
              ] },
            ] },
          { id: "manager-new-person", title: "Adding someone new", for: ["manager"],
            summary: "Tyler sets up every account. Send him who's joining, their role and their email.",
            blocks: [
              { p: "Then send them this page with their role on the end of the link: ?role=closer or ?role=setter." },
            ] },
        ],
      },
      ],
    },
  ],
};
