// The AT&T replay's data (generated; do not edit by hand):
// the steps the agent worked through with their real call times in seconds,
// the lines that were said (words from the real call, trimmed; personal
// details left out), and two timelines that map call seconds to replay
// seconds: a quick silent one, and a voiced one paced around the recreated
// voices in assets/replay.

export interface ReplayCheck { at: number; label: string }
export interface ReplayStep { id: string; title: string; from: number; to: number; detail: string; checks?: ReplayCheck[] }
export interface ReplayLine { at: number; who: "agent" | "att" | "keys"; text: string }
export interface ReplayTimeline { keys: [number, number][]; endStart: number; total: number; speak: ReadonlyMap<number, number> }

export const CALL = {"company":"AT&T","product":"home internet","before":80.69,"after":40,"months":24,"ends":1509.3,"costUsd":0.3} as const;
export const OFFER_AT = 1260.8;

export const STEPS: readonly ReplayStep[] = [
  {
    id: "dial",
    title: "Call AT&T",
    from: 0,
    to: 17.5,
    detail: "1 (800) 288-2020"
  },
  {
    id: "menu",
    title: "Ask to cancel",
    from: 17.5,
    to: 161.1,
    detail: "tell the phone menu “cancel service”"
  },
  {
    id: "callback",
    title: "Turn down the callback",
    from: 161.1,
    to: 224.8,
    detail: "press 3 to hold the line"
  },
  {
    id: "hold",
    title: "Wait on hold",
    from: 224.8,
    to: 753.6,
    detail: "hold music — the agent waits so you don’t"
  },
  {
    id: "case",
    title: "Make the case",
    from: 753.6,
    to: 829.1,
    detail: "years of on-time payments, the price went back up"
  },
  {
    id: "verify",
    title: "Verify the account",
    from: 829.1,
    to: 1110.5,
    detail: "one PIN, emailed to Matt, relayed by chat"
  },
  {
    id: "upsell",
    title: "Decline the upsell",
    from: 1110.5,
    to: 1205.6,
    detail: "$20 off if you add a phone line — no thanks"
  },
  {
    id: "rival",
    title: "Name a competitor",
    from: 1205.6,
    to: 1260.8,
    detail: "Spectrum just started serving the address"
  },
  {
    id: "terms",
    title: "Lock the terms",
    from: 1260.8,
    to: 1365.5,
    detail: "",
    checks: [
      {
        at: 1275,
        label: "same speed"
      },
      {
        at: 1275,
        label: "no contract"
      },
      {
        at: 1286.4,
        label: "nothing added"
      },
      {
        at: 1312.4,
        label: "no fee to switch"
      },
      {
        at: 1331.3,
        label: "no fee to leave"
      }
    ]
  },
  {
    id: "close",
    title: "Close and hang up",
    from: 1365.5,
    to: 1509.3,
    detail: "new price starts in two billing cycles"
  }
];

export const LINES: readonly ReplayLine[] = [
  {
    at: 40.1,
    who: "agent",
    text: "Cancel service."
  },
  {
    at: 76.4,
    who: "att",
    text: "I heard you say cancel. Do you need to move your service to a new address?"
  },
  {
    at: 77.3,
    who: "agent",
    text: "No."
  },
  {
    at: 161.1,
    who: "att",
    text: "You’ll need to chat with an agent to cancel that. I’ll connect you."
  },
  {
    at: 201.6,
    who: "keys",
    text: "pressed 3 · declined the callback"
  },
  {
    at: 238.4,
    who: "att",
    text: "We are experiencing heavy call volumes…"
  },
  {
    at: 753.6,
    who: "att",
    text: "Hello, how can I help you?"
  },
  {
    at: 803.1,
    who: "agent",
    text: "Honestly, Matt’s thinking about canceling because of the price, but Matt’s paid every month for years and would love to stay. Is there anything you could do?"
  },
  {
    at: 829.1,
    who: "att",
    text: "I’m gonna help you with a promotion."
  },
  {
    at: 1110.5,
    who: "att",
    text: "Okay, I’m in."
  },
  {
    at: 1128.7,
    who: "att",
    text: "Does Matt have cell phones with AT&T?"
  },
  {
    at: 1130.1,
    who: "agent",
    text: "Matt’s not looking to add anything, just hoping to bring the internet price down."
  },
  {
    at: 1148.5,
    who: "att",
    text: "When he gets a cell phone, he gets a twenty dollar discount for life."
  },
  {
    at: 1205.6,
    who: "agent",
    text: "Spectrum just started offering service at Matt’s address, so Matt’s honestly weighing a switch."
  },
  {
    at: 1228.7,
    who: "att",
    text: "We’re the only one that offers fiber. Spectrum is not a fiber company."
  },
  {
    at: 1260.8,
    who: "att",
    text: "I do have a promotion: forty dollars for two years. It is cheaper than Spectrum."
  },
  {
    at: 1262.5,
    who: "agent",
    text: "Is that on Matt’s current plan and speed, with no contract?"
  },
  {
    at: 1275,
    who: "att",
    text: "Yes, same speed, no contract."
  },
  {
    at: 1318.6,
    who: "agent",
    text: "If Matt cancels before the two years are up, is there any fee?"
  },
  {
    at: 1331.3,
    who: "att",
    text: "No."
  },
  {
    at: 1365.5,
    who: "att",
    text: "The forty will start in two billing cycles."
  },
  {
    at: 1506,
    who: "agent",
    text: "Thanks so much, you too. Bye!"
  }
];

export const SILENT: ReplayTimeline = {
  keys: [[0,0],[17.5,1.2],[224.8,6.2],[753.6,10.4],[1110.5,14.4],[1260.8,21.4],[1365.5,26],[1509.3,28.2]],
  endStart: 29.2,
  total: 40,
  speak: new Map(),
};

export const VOICED: ReplayTimeline = {
  keys: [[0,0],[40.1,1.745],[76.4,3.234],[77.3,7.332],[161.1,9.354],[201.6,12.746],[238.4,13.596],[753.6,20.236],[803.1,22.061],[829.1,31.21],[1110.5,34.364],[1128.7,35.741],[1130.1,38.377],[1148.5,42.583],[1205.6,46.249],[1228.7,51.471],[1260.8,55.504],[1262.5,60.418],[1275,63.977],[1318.6,66.694],[1331.3,70.341],[1365.5,71.844],[1506,74.432],[1509.3,76.846]],
  endStart: 77.646,
  total: 87.646,
  speak: new Map([[40.1,1.039],[76.4,3.648],[77.3,0.361],[161.1,2.943],[201.6,0.4],[238.4,2.19],[753.6,1.374],[803.1,8.7],[829.1,1.496],[1110.5,0.926],[1128.7,2.186],[1130.1,3.757],[1148.5,3.215],[1205.6,4.772],[1228.7,3.584],[1260.8,4.464],[1262.5,3.108],[1275,2.267],[1318.6,3.198],[1331.3,0.308],[1365.5,2.138],[1506,1.614]]),
};

// Each sound and the replay second it starts at, on the voiced timeline.
export const CUES: readonly { at: number; file: string }[] = [
  {
    at: 0.05,
    file: "att-00.m4a"
  },
  {
    at: 1.745,
    file: "att-01.m4a"
  },
  {
    at: 3.234,
    file: "att-02.m4a"
  },
  {
    at: 7.332,
    file: "att-03.m4a"
  },
  {
    at: 9.354,
    file: "att-04.m4a"
  },
  {
    at: 12.746,
    file: "att-05.m4a"
  },
  {
    at: 13.596,
    file: "att-06.m4a"
  },
  {
    at: 15.986,
    file: "att-07.m4a"
  },
  {
    at: 20.236,
    file: "att-08.m4a"
  },
  {
    at: 22.061,
    file: "att-09.m4a"
  },
  {
    at: 31.21,
    file: "att-10.m4a"
  },
  {
    at: 34.364,
    file: "att-11.m4a"
  },
  {
    at: 35.741,
    file: "att-12.m4a"
  },
  {
    at: 38.377,
    file: "att-13.m4a"
  },
  {
    at: 42.583,
    file: "att-14.m4a"
  },
  {
    at: 46.249,
    file: "att-15.m4a"
  },
  {
    at: 51.471,
    file: "att-16.m4a"
  },
  {
    at: 55.504,
    file: "att-17.m4a"
  },
  {
    at: 60.418,
    file: "att-18.m4a"
  },
  {
    at: 63.977,
    file: "att-19.m4a"
  },
  {
    at: 66.694,
    file: "att-20.m4a"
  },
  {
    at: 70.341,
    file: "att-21.m4a"
  },
  {
    at: 71.844,
    file: "att-22.m4a"
  },
  {
    at: 74.432,
    file: "att-23.m4a"
  },
  {
    at: 77.646,
    file: "att-24.m4a"
  }
];
