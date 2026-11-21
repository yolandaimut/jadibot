// --- skema struktur default users, groups, chats, dan settings ---
const expiration = 86400;
const welcomeText = 'Hello, +user Thank you for joining the group +group\n\nPlease intro first :\nName :\nAge :\nHome town :';
const goodbyeText = 'Goodbye +user';

const badwordList = [
  'ajg', 'anjink', 'anjg', 'anjk', 'anjim', 'anjing', 'anjrot', 'anying',
  'asw', 'autis', 'babi', 'bacod', 'bacot', 'bagong', 'bajingan', 'bangsad',
  'bangsat', 'bastard', 'bego', 'bgsd', 'biadab', 'biadap', 'bitch', 'bngst',
  'bodoh', 'bokep', 'cocote', 'coli', 'colmek', 'comli', 'dajjal', 'dancok',
  'dongo', 'fuck', 'goblog', 'goblok', 'guoblog', 'guoblok', 'henceut', 'idiot',
  'jancok', 'jembut', 'jingan', 'kafir', 'kanjut', 'keparat', 'kntl', 'kontol',
  'lonte', 'meki', 'memek', 'ngentod', 'ngentot', 'ngewe', 'ngocok', 'ngtd',
  'njeng', 'njing', 'njinx', 'pantek', 'peler', 'pepek', 'pler', 'pucek',
  'puki', 'pukimak', 'setan', 'silit', 'telaso', 'tempek', 'tete', 'titit',
  'toket', 'tolol', 'tomlol', 'asu', '4su', 'asww', 'kntol', 'mmk', 'mmek', 'memk'
];

const Models = {
  users: {
    register: false,
    gender: '',
    age: 0,
    date: '',
    limit: 15,
    balance: 10000,
    afk: 0,
    alasan: '',
    afkObj: null,
    premium: false,
    banned: false,
    blocked: false,
    warning: 0,
    pasangan: {
      id: '',
      time: 0
    },
    expired: {
      user: 0,
      premium: 0,
      banned: 0,
      jadibot: 0
    },
    game: {
      tictactoe: 0,
      suit: 0,
      petakbom: 0,
      tebaklagu: 0,
      tebakheroml: 0,
      tebaklogo: 0,
      tebakgambar: 0,
      tebakkalimat: 0,
      tebakkata: 0,
      tebaklirik: 0,
      tebakkimia: 0,
      tebakbendera: 0,
      tebakanime: 0,
      kuis: 0,
      siapakahaku: 0,
      asahotak: 0,
      susunkata: 0,
      caklontong: 0,
      family100: 0,
      math: 0,
      casino: 0,
      werewolf: 0
    },
    lastunreg: 0,
    exp: 0,
    level: 0,
    role: 'Gak kenal',
    ultah: {
      status: false,
      date: ''
    }
  },
  groups: {
    expiration,
    welcomeText,
    goodbyeText,
    welcome: false,
    goodbye: false,
    detect: false,
    mute: false,
    banned: false,
    antitoxic: false,
    antilink: true,
    antivirtex: true,
    antibot: false,
    antiluar: false,
    antihidetag: false,
    antidelete: false,
    antiedited: false,
    antispam: true,
    antihacked: false,
    autosholat: false,
    antigsm: false,
    countchat: true,
    autokicksider: false,
    verification: false,
    autodonate: false,
    referral: false,
    expired: 0,
    sewa: {
      status: false,
      vip: false,
      notice: false,
      expired: 0
    },
    warning: {
      text: '*#WARNING CARD*\n──────── ୨୧ ────────\n*Violation by* : +tag\n*Rule violated* : +reason\n*Warning count* : +limit\n \n> Consequences for severe violations include blacklist / kick!!',
      limit: 3
    },
    absen: {},
    list: [],
    blacklist: [],
    member: [],
    alarm: []
  },
  chats: {
    chat: 0,
    lastseen: 0,
    data: {}
  },
  settings: {
    multiprefix: true,
    prefix: '.',
    online: true,
    verify: false,
    self: false,
    groupmode: false,
    maintenance: false,
    autodownload: false,
    autoreadsw: true,
    autoreact: true,
    autoblockcmd: false,
    autoclearsession: false,
    anticall: true,
    antispam: true,
    autolevelup: true,
    packname: 'Surya Core\n\n+date\n+time',
    author: 'JadiBot Enterprise',
    cover: '',
    link: '',
    linkgc: '',
    style: 1,
    timer: 1800000,
    gamewaktu: 60,
    hadiah: { min: 1000, max: 3000 },
    limit: { premium: 99999, free: 50, price: 1000 },
    max_upload: { premium: 100, free: 10 },
    lastreset: Date.now(),
    max_toxic: 15,
    toxic: badwordList
  }
};

export default Models;
