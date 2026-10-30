import type { Guide } from "./types";

/**
 * Dating (Nelly Sudri). Facts as the offer runs on 2026-10-30: Calendly books, Zoom hosts, Fathom records closing calls, the
 * end of day writes results to GHL. Channel names are the workspace's own (#dating-traige-booked is spelled that way in Slack).
 */
export const datingNelly: Guide = {
  slug: "dating-nelly",
  brand: { name: "Nelly Sudri", accent: "#281a39" },
  title: "Welcome to the team",
  intro: "This page walks you through everything you need to start taking calls with us: the accounts to set up, how a call runs from booking to close, your end-of-day report, and how we use Slack. Pick your role below, then go top to bottom.",
  parts: [
    {
      id: "welcome", title: "Welcome", sections: [
        { id: "who-we-are", title: "Who we are", for: ["closer", "setter", "manager"],
          summary: "Nelly Sudri helps people get serious about dating and find a real relationship.",
          blocks: [
            { video: { title: "A welcome from Nelly", url: null } },
            { p: "People find Nelly, fill out the VIP Matchmaking Application, and book a call with the team. Our job is to talk with each of them, find out whether Nelly can help, and help the right people get started." },
          ] },
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
              "They book the strategy session. It's posted in #dating-traige-booked.",
              "The setter calls them at the booked time.",
              "If they fit, the setter books the closing call with their setter link. It's posted in #dating-calls-booked.",
              "The closer runs the consultation on the Zoom link, with Fathom recording.",
              "The recording lands in #dating-sales-call-recording with AI notes and a score.",
              "At the end of the day, everyone files their end-of-day report. That report is what records the result in GHL.",
              "A close counts once they've signed and paid more than a deposit. Deals show up in #dating-deal-status.",
            ] },
          ] },
      ],
    },
    {
      id: "setup", title: "Getting set up", sections: [
        { id: "accounts", title: "Your accounts", for: ["closer", "setter", "manager"],
          summary: "Accept every invite as soon as it arrives. You can't take calls until these are done.",
          blocks: [
            { rows: [
              ["Google", "Your work Google account. The invite comes by email; accept it first, since you'll sign in to the other tools with it."],
              ["Slack", "Join the workspace from the invite, then join the channels for your role (see Slack below)."],
              ["Calendly", "Accept the invite to the team. Closers are added to the consultation calendar; setters get their own booking link."],
              ["GoHighLevel", "Tyler adds you as a user. This is where the contacts, cards and call records live."],
              ["Zoom", "Tyler invites you. Closers host their calls from this account."],
              ["Fathom", "Tyler invites you. It records your Zoom calls so they show up in Slack."],
            ], head: ["Account", "What to do"] },
            { note: "Use the same email for GHL and Slack if you can. That's how the system knows the Slack person and the GHL user are both you.", tone: "important" },
          ] },
        { id: "calendly-zoom", title: "Connect Calendly to Zoom", for: ["closer", "manager"],
          summary: "This is what puts a Zoom link on every call you're booked for.",
          blocks: [
            { video: { title: "Connecting Calendly to Zoom", url: null } },
            { steps: [
              "Sign in to Calendly with your work Google account.",
              "Open Integrations & apps, find Zoom, and click Connect.",
              "Sign in to Zoom with the account Tyler invited you to and allow access.",
              "Open the Private Dating Consultation event and check that its location is Zoom.",
              "Book a test with yourself and confirm the invite has a Zoom link.",
            ] },
            { note: "If Zoom ever disconnects, new bookings come in without a link and the system flags it in Slack right away. Reconnect it the same way.", tone: "tip" },
          ] },
        { id: "fathom", title: "Set up Fathom", for: ["closer", "manager"],
          summary: "Fathom records your consultations. The recording is how the call gets its notes and score.",
          blocks: [
            { steps: [
              "Accept the Fathom invite and sign in with your work account.",
              "Connect your calendar and Zoom when Fathom asks.",
              "Turn on auto-record for external meetings, so you never have to remember.",
            ] },
          ] },
        { id: "setter-link", title: "Your setter booking link", for: ["setter", "manager"],
          summary: "Book every closing call through your own link so it's credited to you.",
          blocks: [
            { p: "Tyler sends you your link. It's the consultation booking page with your first name on the end. Use it every time you book a closing call for someone, either by sending it to them or by booking it while you're on the phone." },
          ] },
      ],
    },
    {
      id: "calls", title: "Running your calls", sections: [
        { id: "triage-call", title: "Running a strategy session", for: ["setter", "manager"],
          summary: "A phone call through GHL. It's recorded and read automatically.",
          blocks: [
            { steps: [
              "Check #dating-traige-booked for who's coming up. Each post shows their application answers.",
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
              "Find the call in #dating-calls-booked. The post has their application answers, and you get a thread there for anything about this call.",
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
            { p: "Within a few minutes of hanging up, check #dating-sales-call-recording for your call." },
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
              "Once you file, your day posts in #dating-reports.",
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
              ["#dating-traige-booked", "Strategy sessions booked, cancelled and filed. Setters."],
              ["#dating-calls-booked", "Consultations booked, moved and cancelled, and missing Zoom links. Everyone."],
              ["#dating-setters", "What each setter call found. Setters."],
              ["#dating-sales-call-recording", "Each consultation's recording, notes and score. Closers."],
              ["#dating-deal-status", "Agreements, payments and closes. Closers and managers."],
              ["#dating-reports", "End-of-day reports, daily and weekly wrap-ups, the leaderboard. Everyone."],
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
              "Missing Zoom links on upcoming consultations (🔗 in #dating-calls-booked).",
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
};
