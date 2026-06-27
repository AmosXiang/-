import { VideoAnalysis } from "./types";

// Asset URLs as string constants to avoid TS compile-time asset import issues
const airshipImg = "/src/assets/images/steampunk_airship_1782410164264.jpg";
const girlImg = "/src/assets/images/gothic_girl_avatar_1782410178182.jpg";
const professorImg = "/src/assets/images/steampunk_professor_1782410189707.jpg";
const warriorImg = "/src/assets/images/bearded_warrior_1782410199322.jpg";
const portalSkyImg = "/src/assets/images/portal_sky_1782410267647.jpg";
const snowSlopeImg = "/src/assets/images/snow_slope_1782410279863.jpg";
const underwaterReefImg = "/src/assets/images/underwater_reef_1782410292175.jpg";
const candyLandImg = "/src/assets/images/candy_land_1782410304667.jpg";

export const videoAnalysisData: VideoAnalysis = {
  shots: [
    {
      id: "shot-1",
      timestamp: "00:00 - 00:07",
      timeSeconds: 3,
      movement: "全景航拍转倾斜俯冲 (Aerial Wide to Dive)",
      composition: "对称构图及下三分法构图",
      emotion: "震撼、壮丽、充满冒险史诗感",
      description: "一艘巨大的蒸汽飞空艇在白云缭绕的崇山峻岭间飞行，随后镜头垂直向下，俯冲展现飞空艇的动力推进装置，奠定了影片宏大的奇幻工业世界观。",
      imageUrl: airshipImg
    },
    {
      id: "shot-2",
      timestamp: "00:07 - 00:27",
      timeSeconds: 15,
      movement: "低角度脚步跟拍至舱内推轨 (Low-Angle Tracking)",
      composition: "利用两侧金属阀门与舱壁形成汇聚线/框架构图",
      emotion: "神秘、沉闷、暗流涌动",
      description: "舱内昏暗且充满金属感，神秘的黑发少女在前方走，沉重的厚底长靴发出回音。同行的赫伯特教授正在激烈地抱怨因迷路耽误了十二分钟。",
      imageUrl: girlImg
    },
    {
      id: "shot-3",
      timestamp: "00:27 - 00:40",
      timeSeconds: 32,
      movement: "中景对话 (Medium Shot) 结合角色面部特写",
      composition: "黄金分割点构图，聚焦教授面部细节",
      emotion: "风趣、辩论气氛、日常拌嘴",
      description: "赫伯特教授嘴硬推眼镜，宣称自己的伪装计划完美无瑕。巴扎尔无情戳穿：你把伪造的单子交给了一个不识字、甚至把纸拿反了的守卫！",
      imageUrl: professorImg
    },
    {
      id: "shot-4",
      timestamp: "00:40 - 00:57",
      timeSeconds: 48,
      movement: "定机位双人特写 (Two-Shot Close-Up)",
      composition: "强烈的左右对比构图，一糙一雅形成心理落差",
      emotion: "荒诞喜感、嫌弃",
      description: "巴扎尔毫不在意地用手指挖起鼻孔，教授感到极大生理不适。质问他是否在用手指挖鼻子，巴扎尔反讽说难道应该用叉子，教授则要求他保持‘基本文明’。",
      imageUrl: warriorImg
    },
    {
      id: "shot-5",
      timestamp: "00:57 - 01:13",
      timeSeconds: 65,
      movement: "通道透视拉推镜 (Dolly Dynamic)",
      composition: "三分法、通道透视，灯光摇曳",
      emotion: "诙谐、市井冒险气",
      description: "舱顶气阀喷出蒸汽，吊灯剧烈晃动。巴扎尔嬉皮笑脸说他在‘寻找宝藏’。教授吐槽‘在鼻子里？’巴扎尔回敬‘在里面找到的东西比你前三张地图还要多！’",
      imageUrl: portalSkyImg
    },
    {
      id: "shot-6",
      timestamp: "01:13 - 01:31",
      timeSeconds: 80,
      movement: "高低位垂直跟拍 (Downtrack Vertical)",
      composition: "纵向垂直分割画面，少女沿梯子下行",
      emotion: "欢乐、相互吐槽、羁绊加深",
      description: "少女沿铁梯轻盈走下，教授继续输出：‘如果谁活得像野兽，绝对是你，还记得吃生肉那次吗？’巴扎尔不甘示弱：‘那是蛋白质！你只是嫉妒我能消化。’",
      imageUrl: girlImg
    },
    {
      id: "shot-7",
      timestamp: "01:31 - 01:56",
      timeSeconds: 105,
      movement: "第一人称开门 (POV) 到广角摇摄 (Pan Panorama)",
      composition: "框式逆光，地平线处于中下段，云海在阳光下波澜壮阔",
      emotion: "心旷神怡、波澜壮阔、危机临近",
      description: "少女利落拉开沉重舱门，狂风大作。外面是高达万米的高空云海，远处漂浮着一艘飞空帆船。少女回头抛下一句‘下去的时候尽量别叫’，十分挑衅。",
      imageUrl: portalSkyImg
    },
    {
      id: "shot-8",
      timestamp: "01:56 - 02:07",
      timeSeconds: 118,
      movement: "高速自由落体跟拍 (Free-fall Tracking)",
      composition: "俯仰视差，少女居中，放射线流线线条",
      emotion: "惊险、狂放、自由感",
      description: "少女张开双臂，优雅地向云海仰面坠下，动作潇洒完美。巴扎尔在甲板边哈哈大笑赞叹‘这才是我欣赏的女人！’，并戏谑教授是不是恐高。",
      imageUrl: portalSkyImg
    },
    {
      id: "shot-9",
      timestamp: "02:07 - 02:25",
      timeSeconds: 135,
      movement: "镜头急速推拉 (Dolly Zoom) 与搞笑定格",
      composition: "教授侧身近景，巴扎尔突然消失打破平衡",
      emotion: "滑稽、强作镇定、认命",
      description: "教授嘴硬：‘我只是在计算最佳降落角度！’巴扎尔大吼‘那你去算算这个吧！’说完后仰尖叫跳下。教授绝望自语‘我讨厌这个队伍’，也无奈跃下。",
      imageUrl: professorImg
    },
    {
      id: "shot-10",
      timestamp: "02:25 - 03:24",
      timeSeconds: 165,
      movement: "高空平行摇摆跟拍 (Skydive Parallel)",
      composition: "并列飞行，风阻形变，背景是无际蔚蓝和白云",
      emotion: "极度亢奋、强烈的速度和失重冲击",
      description: "三人如同鸟儿般穿过云海。巴扎尔大吼‘这才是生活！’，并疯狂嘲笑脸色煞白、还在手忙脚乱强装‘一切尽在掌握’的教授。少女则在一旁优雅滑行。",
      imageUrl: portalSkyImg
    },
    {
      id: "shot-11",
      timestamp: "03:24 - 03:39",
      timeSeconds: 210,
      movement: "特效穿越快摇 (Portal Swipe to Slide)",
      composition: "斜向对角线构图，洁白雪山与黑色风暴传送门对撞",
      emotion: "极速丝滑、环境异样的震撼",
      description: "少女在空中凭空召唤一个黑色漩涡传送门，穿过后瞬间落在一座巍峨的雪山上，她凭借重靴如同滑雪板一般在陡峭雪坡上极速画弧滑行。",
      imageUrl: snowSlopeImg
    },
    {
      id: "shot-12",
      timestamp: "03:39 - 03:55",
      timeSeconds: 228,
      movement: "动态剪辑对比 (Split Contrast Editing)",
      composition: "左半边少女轻灵滑行，右半边两人狼狈翻滚",
      emotion: "滑稽搞笑、惊险万分",
      description: "两个大男人从传送门滚落砸进雪堆，惨遭雪崩式翻滚。教授绝望惨叫‘这不叫减速！这只是换了个姿势往下掉！’，巴扎尔嘴硬‘总比走路强！’",
      imageUrl: snowSlopeImg
    },
    {
      id: "shot-13",
      timestamp: "03:55 - 04:12",
      timeSeconds: 245,
      movement: "水下静止平移变焦 (Underwater Dolly)",
      composition: "深海透视，巨型珊瑚群环绕形成天然景框",
      emotion: "静谧、绚丽多彩、奇幻治愈",
      description: "他们穿过第二道蓝色水下传送门，掉进美丽的深海珊瑚礁。海水过滤了嘈杂，色彩斑斓的鱼群在身样游弋。教授惊呼：‘这难道是物质的彻底转化？’",
      imageUrl: underwaterReefImg
    },
    {
      id: "shot-14",
      timestamp: "04:12 - 04:26",
      timeSeconds: 258,
      movement: "高饱和宽荧幕移摄 (Technicolor Track)",
      composition: "色彩散点分布，透视纵深，卡通波普艺术风",
      emotion: "怪诞离奇、童话幻想狂潮",
      description: "他们穿入粉色传送门，跌进不可思议的糖果乐园。周围环绕着高耸的彩虹棒棒糖、巨型果冻和蛋糕。教授精神崩溃：‘我绝不承认这种地方真实存在！’",
      imageUrl: candyLandImg
    },
    {
      id: "shot-15",
      timestamp: "04:26 - 04:45",
      timeSeconds: 275,
      movement: "低仰角旋转定机位 (Low-Angle Orbit with Hammer Summon)",
      composition: "对称废墟构图，少女作为立柱主轴，废墟列柱形成围合",
      emotion: "极致炫酷、霸气外露、转折危机",
      description: "他们摔进荒凉沙漠废墟，两男面部着地。少女优雅平稳降落，白皙玉手轻轻一抓，巨型黑铁战锤自虚空飞回。巴扎尔惊叹：‘这是什么魔法？’‘…减速带。’",
      imageUrl: candyLandImg
    },
    {
      id: "shot-16",
      timestamp: "04:45 - 05:02",
      timeSeconds: 290,
      movement: "横摇全景展示 (Pan Group Standoff)",
      composition: "敌对双方双向拉扯的对称张力构图",
      emotion: "千钧一发、热血激昂、决战前奏",
      description: "荒废的石柱遗迹中，无数白色尖牙怪兽和灰皮大眼异形正包围他们。巴扎尔吐槽：‘这就是为什么我讨厌帮你忙，博士。’教授：‘我会弥补的，我来解决！’",
      imageUrl: candyLandImg
    },
    {
      id: "shot-17",
      timestamp: "05:02 - 05:37",
      timeSeconds: 320,
      movement: "动态慢动作大摇移 (Action Slow-mo Dolly Out)",
      composition: "中心焦点透视，神庙大门作为消失点，三人并排前行",
      emotion: "热血高燃、逗比未完、余韵悠长",
      description: "激烈的废墟群架，巴扎尔挥锤爆破，教授手持金灿双管火枪精准轰击，少女横扫。战后，两男又喋喋不休地开始调侃少女娇小‘紧凑’的体型。最后三人一同走入神庙大门，冒险仍在继续。",
      imageUrl: candyLandImg
    }
  ],
  characters: [
    {
      name: "黑发少女 / 萝莉魔法使",
      role: "团队战力担当与法术核心 (时空穿梭者)",
      personality: "沉着冷静、面无表情、果断干练，带有一丝高冷的冷血萌。她说话言简意赅，对同伴的喧闹与嘴碎常常报以嫌弃的眼神，但实力深不可测，能在极速坠落中精准操控多个维度的传送门，更能凭空召唤并单手操纵一柄巨大的破空战锤。",
      clothing: "黑色羽翼般连帽中长披风，高领交叉细带颈链，精致十字架耳坠，黑皮抹胸露腹内搭，黑色朋克超短皮裤，双排金属扣黑皮腰带，一双极富设计感的超厚底高帮长筒漆皮战靴，腿部白皙，形成极致色彩反差。",
      avatarUrl: girlImg,
      quote: "下去的时候尽量别叫。……这只是减速带。",
      skills: ["虚空穿梭门", "重力改写术", "黑铁重锤召唤", "丝滑重体力学控制"],
    },
    {
      name: "赫伯特教授 (Herbert / 博士)",
      role: "学者、带路党兼智囊，远程火器辅助",
      personality: "极度神经质、傲娇、有点洁癖、理论派学者。喜欢碎碎念和计算各种安全参数（如最佳下降角度），十分看重文明与体面，对巴扎尔的粗鲁行径深恶痛绝，极其讨厌失控感，但其实关键时刻胆识过人，能用精准而绅士的火枪枪法提供可靠火力。",
      clothing: "考究的深灰磨砂皮长风衣，质感上乘，内搭带褶皱的英伦立领衬衫、修身格子马甲并整齐地系着黑色领带。金丝单边细链吊挂式复古圆框眼镜，皮质战术背包，背负有整卷的防水探险地图及睡袋，典型的蒸汽朋克学者装扮。",
      avatarUrl: professorImg,
      quote: "我绝不承认这种荒谬的地方真实存在！……这不叫减速，这只是换了个姿势往下掉！",
      skills: ["最佳弹道计算", "双管蒸汽转轮火枪", "废墟考古解码", "喋喋不休的抗议"],
    },
    {
      name: "巴扎尔 (Bazar / 狂战士)",
      role: "重装怪力前排，近战力量核心",
      personality: "大智若愚、极其豪爽粗犷、大大咧咧，对刺激探险拥有疯狂的热爱。他毫无洁癖、生活野蛮，比如喜欢徒手抠鼻子、生啃怪物血肉、把生肉称作‘纯天然蛋白质’。与精细的教授形成鲜明反差，极其擅长以最直接的物理方式扫平障碍，战斗风格大开大合，热情洋溢。",
      clothing: "红褐色编织绑带无袖皮革紧身背心，露出壮硕茂密的胸肌、双臂与圆滚滚的腹部，白粗棉布衬衫半卷袖口，腰系带有骷髅和兽皮装饰的重型宽皮带，悬挂各种药剂，深色工装长裤，磨损严重的厚皮军靴，极具维京/废土游侠风格。",
      avatarUrl: warriorImg,
      quote: "哈哈哈！这才是生活！……你是不是恐高，教授？",
      skills: ["爆裂巨锤重击", "极致抗揍体格", "天然蛋白质消化力", "强力吐槽与物理搜索"],
    }
  ],
  narrative: {
    structure: "经典的三段式公路片结构：【日常逗比开场】飞空艇内关于计划失败、迷路以及生活习惯的喜剧争吵 → 【极速感官穿梭】跳伞后一气筹成的天、雪山、深海、糖果王国多重超现实空间无缝传送，视觉奇观爆点层出不穷 → 【荒漠热血决战】坠落在古迹废墟遭遇怪兽大军合力格杀，并在幽默诙谐中再次走向深邃神庙。整个结构起承转合自然，角色特质在危机中展现得淋漓尽致。",
    rhythm: "影片剪辑节奏极快，平均每个镜头仅停留2秒。开场通过密集的台词和神态特写稳步铺垫；跳伞瞬间爆发肾上腺素，搭配动感十足的R&B复古电音配乐，画面以飞一样的手法在雪山、深海和糖果乐园中横跨，目不暇接。荒漠落地后，怪兽围攻在慢镜重锤中展现出充满打击感的顿挫节奏。最终以远景漫步的平静步伐收尾，张弛极佳。",
    climaxDesign: "爽点设计直击核心：①【视觉跃迁爽感】：高空、雪山、深海、糖果乐园、风沙遗迹，多种冲突风格在短时间内无缝交织，极大刺激了眼球。②【人物反差爽感】：看似娇小、一风吹跑的黑衣少女，拥有随手唤起并单手挥舞砸碎地面的巨锤，力量反差感震撼十足。③【默契配合燃点】：上一秒还在拌嘴嫌弃的废柴二人组，在野兽围击的刹那，重锤呼啸横扫，金枪火舌爆裂，少女御空统筹，爆发出热血团战默契。"
  }
};
