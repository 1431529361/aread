import { normalizeText } from '../src/core/rag/chunk';

export interface EvalChapter {
  title: string;
  paragraphs: string[];
}

export interface EvalBook {
  id: string;
  title: string;
  format: 'txt';
  chapters: EvalChapter[];
}

export type EvalQuestionType =
  | 'fact'
  | 'character'
  | 'cross'
  | 'followup'
  | 'refusal';

export interface EvalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface EvalQuestion {
  id: string;
  bookId: string;
  type: EvalQuestionType;
  question: string;
  goldAnswer: string;
  goldSpan?: string;
  priorTurns?: EvalTurn[];
}

const FILLER_SENTENCES = [
  '海风从屋檐下穿过，带来一点潮湿的咸味，远处的灯一盏接一盏亮起来。',
  '桌子上的旧报纸被风翻开，露出几行模糊的字，没有人去把它合上。',
  '街角的树影在地面上缓慢移动，像一条没有声音的河。',
  '他停下来听了一会儿，只听见自己的脚步声和远处水面的回响。',
  '窗台上的灰尘被阳光照亮，细小的颗粒在空气里上下浮动。',
  '木门开合时发出低低的声音，像在提醒屋里的人时间已经不早了。',
  '天色一点点暗下去，屋檐下的影子被拉得很长。',
  '有人在巷口低声说话，话音很快被风吹散，只剩下几个模糊的音节。',
  '旧椅子靠墙放着，扶手上留着一道被反复摩挲出来的浅痕。',
  '雨水顺着瓦片滑下来，在石阶上积成一小片浅浅的水洼。',
  '路边的草叶沾着露水，鞋尖碰过去时会留下一条细细的痕迹。',
  '远处的钟声隔着雾传过来，听起来比实际的距离更远一些。',
];

function fillerParagraph(
  bookTitle: string,
  chapterTitle: string,
  chapterIndex: number,
  paragraphIndex: number,
): string {
  const first =
    FILLER_SENTENCES[(chapterIndex * 5 + paragraphIndex) % FILLER_SENTENCES.length];
  const second =
    FILLER_SENTENCES[
      (chapterIndex * 3 + paragraphIndex * 2 + 4) % FILLER_SENTENCES.length
    ];
  return `${bookTitle}的${chapterTitle.replace(/^第.+?章\s*/, '')}里，${first}${second}`;
}

export function bookContent(book: EvalBook): string {
  return normalizeText(
    book.chapters
      .map((chapter, chapterIndex) => {
        const fillers = Array.from({ length: 12 }, (_, index) =>
          fillerParagraph(book.title, chapter.title, chapterIndex, index),
        );
        const paragraphs = [
          chapter.paragraphs[0],
          ...fillers.slice(0, 4),
          ...chapter.paragraphs.slice(1),
          ...fillers.slice(4),
        ];
        return `${chapter.title}\n${paragraphs.join('\n\n')}`;
      })
      .join('\n\n'),
  );
}

export const EVAL_BOOKS: EvalBook[] = [
  {
    id: 'eval-wugang',
    title: '雾港手记',
    format: 'txt',
    chapters: [
      {
        title: '第一章 雾港的清晨',
        paragraphs: [
          '雾港每天清晨五点二十分被潮声叫醒。海雾从码头一直漫到邮局门口，路灯在水汽里晕成一团模糊的光。林岚是雾港邮局的夜班分拣员，习惯在下班后沿着防波堤走一圈，再回出租屋睡觉。',
          '那天她分拣到一封没有寄件人地址的灰色信封。信封很轻，边角却被海水浸得发硬。她把信塞进外套口袋，决定先不拆。防波堤尽头是废弃的旧钟楼，守塔人周叔正坐在台阶上修补渔网。',
          '周叔说，钟楼的机械钟停在三点四十七分，已经停了十二年。林岚抬头时，海雾正从钟楼的窗缝里涌出来，像一条缓慢移动的白蛇。周叔把一枚黄铜钥匙交给她，钥匙柄上刻着“海鸥”两个字。',
          '“等我不在的时候，再打开北岸仓库的七号门。”周叔说完，又低头补网，仿佛刚才那句话只是随口一提。林岚把钥匙收好，钥匙上的铜锈蹭了她一手。',
        ],
      },
      {
        title: '第二章 旧钟楼',
        paragraphs: [
          '钟楼内部堆满旧航海图，空气里有铁锈和霉木的味道。林岚在齿轮箱后面摸到一本牛皮账本，封面没有标题，只有一道被刀划过的痕迹。账本的最后一页写着“海鸥号，三月十七日，北岸”。',
          '账本记录着十二年前的潮汐和货单，很多条目被人用力划掉。她注意到其中一页夹着一张褪色的照片，照片上周叔和一个年轻男人并肩站在灯塔下，两人的肩膀挨得很近。',
          '照片背面写着一个名字：周远。林岚想起周叔从不提起自己的家人，邮局的老同事也只说周叔年轻时出过一趟远门。她把照片放回原处，听见钟楼外传来潮水拍岸的声音。',
        ],
      },
      {
        title: '第三章 北岸仓库',
        paragraphs: [
          '北岸仓库的七号门被海盐锈住。林岚用黄铜钥匙拧了三次，门轴才发出低沉的呻吟。仓库里只有一排木箱，最上面的木箱写着“海鸥”，字迹和钥匙柄上的一模一样。',
          '木箱里不是货物，而是一叠旧报纸。报纸头版报道十二年前“海鸥号”在雾夜失踪，船上五人无人生还。周远的名字出现在失踪名单第二行，后面跟着一个被墨水涂掉的年龄。',
          '林岚把报纸折好，忽然明白周叔交给她的不是钥匙，而是一段被藏起来的过去。仓库的窗外，北岸的礁石在退潮后露出黑色的脊背。',
        ],
      },
      {
        title: '第四章 潮汐表',
        paragraphs: [
          '潮汐表挂在仓库墙上，最后一行用红笔圈出：最低潮，凌晨两点十分。林岚查了当年的记录，发现这个时间与账本上的“三月十七日”吻合，连潮高都只差两厘米。',
          '凌晨两点十分，北岸的礁石会露出一条通往旧灯塔的石阶。石阶尽头是一间没有窗户的地下室，墙上挂着一排生锈的灯罩。周叔说，灯塔的灯罩原本是蓝色的，后来才换成白色。',
          '蓝色玻璃能滤掉雾里的杂光，让船在很远的地方也能看见灯。林岚用手指擦去灯罩上的灰，发现玻璃内侧刻着一行小字：给远。',
        ],
      },
      {
        title: '第五章 灯塔之夜',
        paragraphs: [
          '周叔在灯塔顶层等她。他承认周远是自己的弟弟，也是“海鸥号”的船长。十二年前，周远发现货船被用来走私，故意把船开进雾里，想让证据沉入海底。',
          '周远没有死。他在灯塔北侧的岩洞里留下了一本日志，然后搭渔船离开了雾港。周叔每年都会去岩洞一次，却从未打开日志，只把一壶酒放在洞口。',
          '灯塔的蓝色灯罩在雾里旋转。周叔说，那是给周远的信号：家里还有人等他。林岚站在窗前，看见海面上有一盏微弱的灯回应了一下。',
        ],
      },
      {
        title: '第六章 结局',
        paragraphs: [
          '林岚在岩洞里找到了日志。日志最后一页写着：“如果有一天有人拿着黄铜钥匙来，请告诉他，雾港的灯还亮着。”纸页被潮气浸得发软，字迹却很清楚。',
          '她把日志交给周叔。周叔没有哭，只是把灯罩擦得更亮。第二天，林岚在邮局收到一封没有寄件人的信，信封里是一张去往北方的船票。',
          '雾港的钟楼依旧停在三点四十七分。林岚知道，有些时间不是停了，而是被留在了原地。她把船票放进那枚刻着“海鸥”的钥匙旁边。',
        ],
      },
    ],
  },
  {
    id: 'eval-qinghe',
    title: '青禾镇食单',
    format: 'txt',
    chapters: [
      {
        title: '第一章 早市',
        paragraphs: [
          '青禾镇的早市在清晨五点半开张。第一锅豆腐脑端出来时，街口的雾气还没散。摊主会在豆腐脑上撒一把虾皮，再淋半勺酱油，咸鲜的味道顺着热气往上走。',
          '镇东的米铺只卖当季新米。掌柜说，新米煮粥会起一层薄薄的米油，那是青禾镇人判断米好不好的办法。林素是镇小学的老师，每天早市都会买一块桂花米糕。',
          '她记得小时候，米糕铺的蒸笼总冒着白气，赵奶奶站在蒸笼后面，用一把长刀把米糕切成整齐的小块。早市的声音从巷口一直传到河边。',
        ],
      },
      {
        title: '第二章 面馆老赵',
        paragraphs: [
          '老赵的面馆只有四张桌子，门口挂着一块褪色的木牌。他煮碱水面只数十八秒，多一秒就捞起来过凉水。有人问他为什么这么准，他说面和人一样，泡久了就没精神。',
          '辣椒油是老赵自己熬的，里面放了一小片陈皮。有人问配方，他只说：“陈皮去腥，也让辣味慢一点上来。”面馆的墙上贴着一张手写的价目表，最后一栏永远空着。',
          '老赵的父亲也是面馆师傅。墙上那张黑白照片里，老人站在同一口锅前，手里拿着一双长筷子。老赵说，照片拍完的第二年，父亲就把面馆交给了他。',
        ],
      },
      {
        title: '第三章 河鲜',
        paragraphs: [
          '清明前后，青禾镇的河面会起一层细密的鱼汛。陈伯划着小船撒网，捕上来的白鱼鳞片发亮，肉质最嫩。镇上的人把这段日子叫“吃白鱼的十天”。',
          '陈伯说，白鱼只在清明前后最好吃，过了谷雨，鱼腹里会有细刺，味道也散了。他每天收网后都会在废弃的水车旁坐一会儿，看着水面上的浮萍漂向下游。',
          '河边的风带着青草味。林素有时会买两条白鱼，用姜丝和米酒清蒸。她总把鱼腹留给母亲，因为母亲说那里最鲜。',
        ],
      },
      {
        title: '第四章 糕点铺',
        paragraphs: [
          '桂花米糕要用籼米，不用糯米。米浆磨好后静置一夜，第二天拌入糖桂花，上笼蒸二十五分钟。赵奶奶说，时间短了不熟，时间长了米糕会塌。',
          '蒸好的米糕要趁热切，刀口才会整齐。切糕的刀必须先用热水烫过，这是赵奶奶定下的规矩。铺子里的柜子有一本手写食单，纸页已经发黄。',
          '她不让人翻那本食单，只说等自己不做糕了再交给合适的人。林素每次买糕，都看见食单压在柜台的玻璃板下面，露出一个“灶”字。',
        ],
      },
      {
        title: '第五章 酿酒坊',
        paragraphs: [
          '青禾镇的米酒要发酵四十天。酿酒坊的墙上排着一只只陶坛，坛口用荷叶和泥封住。坊主每天早晨都会用手背贴一贴坛壁，判断温度合不合适。',
          '酒曲是用辣蓼草做的。坊主说，辣蓼草能让酒带一点清苦的香气，也能压住杂菌。每年冬至，镇上的人会打一壶新酒，配上刚蒸好的米糕。',
          '酒香和桂花香混在一起，是青禾镇的冬天。林素不喝酒，但她喜欢看陶坛上凝结的水珠，像一排小小的灯。',
        ],
      },
      {
        title: '第六章 食单的传承',
        paragraphs: [
          '赵奶奶终于把手写食单交给了林素。食单最后一页写着：“灶台后第三块砖，留给愿意慢慢做饭的人。”林素捧着食单，闻到纸上淡淡的桂花味。',
          '她撬开灶台后的第三块砖，里面放着一只小铁盒。铁盒里不是菜谱，而是一张一九八二年的粮票和一张老照片。',
          '照片上，年轻的赵奶奶站在早市摊位前，身后的木牌写着“青禾镇食单”。从那以后，林素每天早市都会多买一块米糕。',
        ],
      },
    ],
  },
  {
    id: 'eval-xinggui',
    title: '星轨档案',
    format: 'txt',
    chapters: [
      {
        title: '第一章 第七码头',
        paragraphs: [
          '第七码头的灯在凌晨四点熄灭。白鹭号完成最后一次检查，计划在七点二十分点火升空。船长沈砚站在舷梯下，手里拿着一份旧星图，星图的边缘已经磨得发白。',
          '白鹭号是一艘中型货运飞船，船舱里装着三台气象卫星。工程师阿禾负责检查推进器，她在每一颗螺栓上画了白色的记号，又在日志里写下当天的湿度。',
          '码头的广播重复着同一句话：“请所有非必要人员离开甲板。”沈砚把旧星图折好，放进胸前的口袋。远处的海面还没有亮，发射塔像一根黑色的针。',
        ],
      },
      {
        title: '第二章 火星中继站',
        paragraphs: [
          '火星中继站的信号要经过十四分钟才能传回地球。阿禾第一次听到延迟提示时，以为通信系统坏了，反复检查了三次天线。',
          '中继站只有一个值班员，叫罗青。她每天的工作是校准天线，记录太阳风强度，然后等待下一艘飞船经过。她的桌子上放着一只旧闹钟，指针永远停在出发那天。',
          '火星表面的沙尘暴持续了三天。罗青在日志里写道：“今天的天空是橙色的，像一张旧照片。”她把这段日志发回地球，信号走了十四分钟。',
        ],
      },
      {
        title: '第三章 失联的探测器',
        paragraphs: [
          '三年前，探测器“风筝三号”在木卫二附近失联。最后一次信号来自木卫二的背面，持续了七秒。控制中心把那段信号反复播放，只听到一阵有规律的脉冲。',
          '沈砚认为那不是故障，而是探测器在发送某种编码。阿禾把脉冲转换成图像，得到一张模糊的环形结构，它看起来像一座漂浮在冰层下的桥。',
          '研究组给那段信号建了一个档案，编号一直空着。沈砚在档案封面上写了一个字：等。',
        ],
      },
      {
        title: '第四章 轨道计算',
        paragraphs: [
          '为了节省燃料，白鹭号选择在木星附近做引力弹弓。计算结果显示，这样可以节省百分之三十八的燃料。阿禾把结果打印出来，贴在驾驶舱的侧壁上。',
          '沈砚在轨道图上画了一条细线，线的末端指向木星背面的阴影。他说：“我们不是去冒险，我们只是借一点力。”阿禾在细线旁边画了一个小小的箭头。',
          '飞船进入阴影后，舷窗外的星光全部熄灭。阿禾数着自己的呼吸，直到飞船重新回到阳光里。推进器的读数比预计的更稳定。',
        ],
      },
      {
        title: '第五章 黑箱记录',
        paragraphs: [
          '白鹭号返航时带回了一只黑色盒子。盒子的编号是七七四一，里面存着风筝三号最后七秒的信号。盒子外壳有一道很深的划痕，像被什么尖锐的东西刮过。',
          '黑箱打开后，最先传出的是一段人声。沈砚听出那是自己三年前的声音，当时他还在另一艘飞船上。录音只有一句话：“如果你听到这里，说明桥已经打开了。”',
          '控制中心没有人能解释这句话。罗青从火星发来一条消息，只有四个字：冰层在动。沈砚盯着屏幕，很久没有说话。',
        ],
      },
      {
        title: '第六章 返航',
        paragraphs: [
          '白鹭号在飞行二百一十天后返回地球。沈砚在新闻发布会上只说了一句话：“有些答案不在星图上。”记者们追问，他却转身离开了讲台。',
          '阿禾把那段录音交给研究组。罗青从火星发来一条消息：“木卫二的冰层下面，可能有我们没见过的海。”消息旁边附着一张模糊的蓝色图像。',
          '沈砚退休后搬到了海边。他每天傍晚都看着天空，直到第一颗星亮起来。阿禾偶尔给他发邮件，主题永远只有一个：风筝三号。',
        ],
      },
    ],
  },
];

export const EVAL_QUESTIONS: EvalQuestion[] = [
  // 雾港手记
  {
    id: 'wugang-q1',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '林岚在雾港做什么工作？',
    goldAnswer: '邮局的夜班分拣员',
    goldSpan: '夜班分拣员',
  },
  {
    id: 'wugang-q2',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '旧钟楼的钟停在几点？',
    goldAnswer: '三点四十七分',
    goldSpan: '三点四十七分',
  },
  {
    id: 'wugang-q3',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '周叔交给林岚的钥匙柄上刻着什么？',
    goldAnswer: '海鸥',
    goldSpan: '钥匙柄上刻着“海鸥”',
  },
  {
    id: 'wugang-q4',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '北岸仓库的门牌号是多少？',
    goldAnswer: '七号',
    goldSpan: '北岸仓库的七号门',
  },
  {
    id: 'wugang-q5',
    bookId: 'eval-wugang',
    type: 'character',
    question: '周叔的弟弟叫什么名字？',
    goldAnswer: '周远',
    goldSpan: '周远',
  },
  {
    id: 'wugang-q6',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '海鸥号失踪时船上有几个人？',
    goldAnswer: '五个人',
    goldSpan: '船上五人无人生还',
  },
  {
    id: 'wugang-q7',
    bookId: 'eval-wugang',
    type: 'cross',
    question: '钟楼里的账本和北岸仓库有什么联系？',
    goldAnswer: '账本最后一页指向北岸，记载了海鸥号的日期和货单',
    goldSpan: '海鸥号，三月十七日，北岸',
  },
  {
    id: 'wugang-q8',
    bookId: 'eval-wugang',
    type: 'fact',
    question: '北岸最低潮出现在几点？',
    goldAnswer: '凌晨两点十分',
    goldSpan: '最低潮，凌晨两点十分',
  },
  {
    id: 'wugang-q9',
    bookId: 'eval-wugang',
    type: 'followup',
    question: '那灯罩原本是什么颜色？',
    goldAnswer: '蓝色',
    goldSpan: '灯罩原本是蓝色的',
    priorTurns: [
      { role: 'user', content: '灯塔的灯有什么特别？' },
      { role: 'assistant', content: '灯罩会在雾里旋转，给海上的船指路。' },
    ],
  },
  {
    id: 'wugang-q10',
    bookId: 'eval-wugang',
    type: 'refusal',
    question: '书中是否提到林岚去过南极？',
    goldAnswer: '书中未提及林岚去过南极',
  },

  // 青禾镇食单
  {
    id: 'qinghe-q1',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '青禾镇早市几点开张？',
    goldAnswer: '清晨五点半',
    goldSpan: '清晨五点半',
  },
  {
    id: 'qinghe-q2',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '豆腐脑上会撒什么？',
    goldAnswer: '虾皮',
    goldSpan: '撒一把虾皮',
  },
  {
    id: 'qinghe-q3',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '老赵煮碱水面要数多少秒？',
    goldAnswer: '十八秒',
    goldSpan: '只数十八秒',
  },
  {
    id: 'qinghe-q4',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '老赵的辣椒油里放了什么？',
    goldAnswer: '陈皮',
    goldSpan: '一小片陈皮',
  },
  {
    id: 'qinghe-q5',
    bookId: 'eval-qinghe',
    type: 'followup',
    question: '那白鱼什么时候最好吃？',
    goldAnswer: '清明前后',
    goldSpan: '白鱼只在清明前后最好吃',
    priorTurns: [
      { role: 'user', content: '青禾镇的河鲜有什么讲究？' },
      { role: 'assistant', content: '清明前后河面会起鱼汛，镇上的人会抓紧时间吃河鲜。' },
    ],
  },
  {
    id: 'qinghe-q6',
    bookId: 'eval-qinghe',
    type: 'character',
    question: '捕白鱼的渔民叫什么？',
    goldAnswer: '陈伯',
    goldSpan: '陈伯划着小船撒网',
  },
  {
    id: 'qinghe-q7',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '桂花米糕要蒸多久？',
    goldAnswer: '二十五分钟',
    goldSpan: '上笼蒸二十五分钟',
  },
  {
    id: 'qinghe-q8',
    bookId: 'eval-qinghe',
    type: 'fact',
    question: '青禾镇的米酒要发酵多少天？',
    goldAnswer: '四十天',
    goldSpan: '米酒要发酵四十天',
  },
  {
    id: 'qinghe-q9',
    bookId: 'eval-qinghe',
    type: 'cross',
    question: '手写食单最后藏在哪里？',
    goldAnswer: '灶台后第三块砖',
    goldSpan: '灶台后第三块砖',
  },
  {
    id: 'qinghe-q10',
    bookId: 'eval-qinghe',
    type: 'refusal',
    question: '书中是否提到青禾镇通了地铁？',
    goldAnswer: '书中未提及青禾镇通地铁',
  },

  // 星轨档案
  {
    id: 'xinggui-q1',
    bookId: 'eval-xinggui',
    type: 'fact',
    question: '飞船叫什么名字？',
    goldAnswer: '白鹭号',
    goldSpan: '白鹭号',
  },
  {
    id: 'xinggui-q2',
    bookId: 'eval-xinggui',
    type: 'character',
    question: '白鹭号的船长是谁？',
    goldAnswer: '沈砚',
    goldSpan: '船长沈砚',
  },
  {
    id: 'xinggui-q3',
    bookId: 'eval-xinggui',
    type: 'fact',
    question: '白鹭号计划几点点火升空？',
    goldAnswer: '七点二十分',
    goldSpan: '七点二十分',
  },
  {
    id: 'xinggui-q4',
    bookId: 'eval-xinggui',
    type: 'fact',
    question: '火星中继站的信号延迟多久？',
    goldAnswer: '十四分钟',
    goldSpan: '信号要经过十四分钟',
  },
  {
    id: 'xinggui-q5',
    bookId: 'eval-xinggui',
    type: 'character',
    question: '负责检查推进器的工程师叫什么？',
    goldAnswer: '阿禾',
    goldSpan: '工程师阿禾',
  },
  {
    id: 'xinggui-q6',
    bookId: 'eval-xinggui',
    type: 'fact',
    question: '失联的探测器叫什么？',
    goldAnswer: '风筝三号',
    goldSpan: '风筝三号',
  },
  {
    id: 'xinggui-q7',
    bookId: 'eval-xinggui',
    type: 'cross',
    question: '风筝三号的失联和木卫二有什么关系？',
    goldAnswer: '最后一次信号来自木卫二背面',
    goldSpan: '最后一次信号来自木卫二的背面',
  },
  {
    id: 'xinggui-q8',
    bookId: 'eval-xinggui',
    type: 'fact',
    question: '引力弹弓方案节省多少燃料？',
    goldAnswer: '百分之三十八',
    goldSpan: '节省百分之三十八的燃料',
  },
  {
    id: 'xinggui-q9',
    bookId: 'eval-xinggui',
    type: 'followup',
    question: '那黑箱的编号是多少？',
    goldAnswer: '七七四一',
    goldSpan: '编号是七七四一',
    priorTurns: [
      { role: 'user', content: '黑箱记录里有什么？' },
      { role: 'assistant', content: '里面存着风筝三号最后七秒的信号，还有一段人声。' },
    ],
  },
  {
    id: 'xinggui-q10',
    bookId: 'eval-xinggui',
    type: 'refusal',
    question: '书中是否提到沈砚去过太阳表面？',
    goldAnswer: '书中未提及沈砚去过太阳表面',
  },
];
