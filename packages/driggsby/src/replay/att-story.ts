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
    detail: "one PIN, emailed to Sam, relayed by chat"
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
    at: 30,
    who: "att",
    text: "Thanks for calling AT&T. In a few words, tell me what you’re calling about."
  },
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
    text: "Honestly, Sam’s thinking about canceling because of the price, but Sam’s paid every month for years and would love to stay. Is there anything you could do?"
  },
  {
    at: 829.1,
    who: "att",
    text: "I’m gonna help you with a promotion."
  },
  {
    at: 1110.5,
    who: "att",
    text: "Ok, I’m in the account. Thanks for verifying."
  },
  {
    at: 1128.7,
    who: "att",
    text: "Does Sam have cell phones with AT&T?"
  },
  {
    at: 1130.1,
    who: "agent",
    text: "Sam’s not looking to add anything, just hoping to bring the internet price down."
  },
  {
    at: 1148.5,
    who: "att",
    text: "When he gets a cell phone, he gets a twenty dollar discount for life."
  },
  {
    at: 1205.6,
    who: "agent",
    text: "Spectrum just started offering service at Sam’s address, so Sam’s honestly weighing a switch."
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
    text: "Is that on Sam’s current plan and speed, with no contract?"
  },
  {
    at: 1275,
    who: "att",
    text: "Yes, same speed, no contract."
  },
  {
    at: 1318.6,
    who: "agent",
    text: "If Sam cancels before the two years are up, is there any fee?"
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
    text: "That sounds perfect. Thanks so much for your help. Bye!"
  }
];

export const SILENT: ReplayTimeline = {
  keys: [[0,0],[17.5,1.2],[224.8,6.2],[753.6,10.4],[1110.5,14.4],[1260.8,21.4],[1365.5,26],[1509.3,28.2]],
  endStart: 29.2,
  total: 40,
  speak: new Map(),
};

export const VOICED: ReplayTimeline = {
  keys: [[0,0],[30,1.65],[40.1,6.103],[76.4,7.592],[77.3,11.69],[161.1,13.711],[201.6,17.104],[238.4,17.954],[753.6,24.594],[803.1,26.418],[829.1,35.875],[1110.5,39.029],[1128.7,42.082],[1130.1,44.862],[1148.5,49.174],[1205.6,52.839],[1228.7,58.313],[1260.8,62.346],[1262.5,67.26],[1275,70.877],[1318.6,73.594],[1331.3,77.566],[1365.5,79.069],[1506,81.657],[1509.3,85.737]],
  endStart: 86.537,
  total: 96.537,
  speak: new Map([[30,4.003],[40.1,1.039],[76.4,3.648],[77.3,0.361],[161.1,2.943],[201.6,0.4],[238.4,2.19],[753.6,1.374],[803.1,9.006],[829.1,1.496],[1110.5,2.604],[1128.7,2.329],[1130.1,3.862],[1148.5,3.215],[1205.6,5.024],[1228.7,3.584],[1260.8,4.464],[1262.5,3.167],[1275,2.267],[1318.6,3.522],[1331.3,0.308],[1365.5,2.138],[1506,3.28]]),
};

// Each sound and the replay second it starts at, on the voiced timeline.
export const CUES: readonly { at: number; file: string }[] = [
  {
    at: 0.05,
    file: "att-00.m4a"
  },
  {
    at: 1.65,
    file: "att-01.m4a"
  },
  {
    at: 6.103,
    file: "att-02.m4a"
  },
  {
    at: 7.592,
    file: "att-03.m4a"
  },
  {
    at: 11.69,
    file: "att-04.m4a"
  },
  {
    at: 13.711,
    file: "att-05.m4a"
  },
  {
    at: 17.104,
    file: "att-06.m4a"
  },
  {
    at: 17.954,
    file: "att-07.m4a"
  },
  {
    at: 20.344,
    file: "att-08.m4a"
  },
  {
    at: 24.594,
    file: "att-09.m4a"
  },
  {
    at: 26.418,
    file: "att-10.m4a"
  },
  {
    at: 35.875,
    file: "att-11.m4a"
  },
  {
    at: 39.029,
    file: "att-12.m4a"
  },
  {
    at: 42.082,
    file: "att-13.m4a"
  },
  {
    at: 44.862,
    file: "att-14.m4a"
  },
  {
    at: 49.174,
    file: "att-15.m4a"
  },
  {
    at: 52.839,
    file: "att-16.m4a"
  },
  {
    at: 58.313,
    file: "att-17.m4a"
  },
  {
    at: 62.346,
    file: "att-18.m4a"
  },
  {
    at: 67.26,
    file: "att-19.m4a"
  },
  {
    at: 70.877,
    file: "att-20.m4a"
  },
  {
    at: 73.594,
    file: "att-21.m4a"
  },
  {
    at: 77.566,
    file: "att-22.m4a"
  },
  {
    at: 79.069,
    file: "att-23.m4a"
  },
  {
    at: 81.657,
    file: "att-24.m4a"
  },
  {
    at: 86.537,
    file: "att-25.m4a"
  }
];
