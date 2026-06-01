const { WebSocket } = require('ws');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PORT = process.env.PORT || 10000;

// ================== Proxy ==================
const PROXY_URL = process.env.PROXY_URL || null;
if (PROXY_URL) {
    console.log("🔀 Dùng proxy:", PROXY_URL.replace(/:\/\/.*@/, '://***@'));
} else {
    console.log("⚠️  Không có proxy, kết nối trực tiếp (có thể bị 403)");
}

// ================== Đọc token từ Environment Variables ==================
let TOKEN_DATA = {};
try {
    const raw = process.env.TOKEN_ALL;
    if (!raw) throw new Error("Biến môi trường TOKEN_ALL chưa được set");
    TOKEN_DATA = JSON.parse(raw);
    console.log("✅ Đã đọc token từ ENV TOKEN_ALL");
} catch (e) {
    console.error("❌ Không đọc được token:", e.message);
    process.exit(1);
}

const MINI_TOKEN = TOKEN_DATA['MiniGame'];
const SIMMS_TOKEN = TOKEN_DATA['Simms'];

// ================== Biến toàn cục ==================
let latestResult = {
    "phien": 0,
    "ket_qua": "Chưa có kết quả",
    "xuc_xac_1": 0,
    "xuc_xac_2": 0,
    "xuc_xac_3": 0,
    "tong": 0,
    "phien_hien_tai": 0,
    "du_doan": "Đang chờ dữ liệu...",
    "do_tin_cay": 0,
    "id": "@sewdangcap"
};

// FIX 2: lastEventId reset về 0 mỗi lần reconnect (không hardcode)
let lastEventId = 0;
let phienLichSu = [];

// ================== Xây dựng message từ token ==================
function buildLoginMessage() {
    const info = MINI_TOKEN.info;
    return [
        1,
        "MiniGame",
        MINI_TOKEN.username,
        MINI_TOKEN.password,
        {
            "info": info.info,
            "signature": info.signature,
            "pid": 4,
            "subi": true
        }
    ];
}

// FIX: đúng plugin + cmd theo browser DevTools
const SUBSCRIBE_TX_RESULT = [6, "MiniGame", "taixiuUnbalancedPlugin", { "cmd": 2000 }];
const SUBSCRIBE_LOBBY     = [6, "MiniGame", "lobbyPlugin",            { "cmd": 10001 }];

// ================== Thuật toán phân tích đòn bẩy bậc 5 ==================
function phanTichDonBay(lichSu) {
    if (lichSu.length < 5) {
        return { duDoanText: "Đang chờ đủ dữ liệu (cần 5 phiên)", doTinCay: 0 };
    }

    const phienGanNhat = lichSu.slice(-5);
    const trongSo = [0.08, 0.12, 0.20, 0.25, 0.35];

    let diemTai = 0;
    let diemXiu = 0;

    for (let i = 0; i < phienGanNhat.length; i++) {
        const phien = phienGanNhat[i];
        const trongSoHienTai = trongSo[i];

        if (phien.tong >= 11) {
            diemTai += (phien.tong - 10) * trongSoHienTai * 0.5;
        } else {
            diemXiu += (11 - phien.tong) * trongSoHienTai * 0.5;
        }

        const doLech = Math.max(phien.xuc_xac_1, phien.xuc_xac_2, phien.xuc_xac_3) -
                       Math.min(phien.xuc_xac_1, phien.xuc_xac_2, phien.xuc_xac_3);

        if (doLech >= 4) {
            if (phien.tong >= 11) {
                diemXiu += doLech * trongSoHienTai * 0.3;
            } else {
                diemTai += doLech * trongSoHienTai * 0.3;
            }
        }

        if (i > 0) {
            const phienTruoc = phienGanNhat[i - 1];
            if (phien.tong >= 11 && phienTruoc.tong >= 11) {
                diemTai += trongSoHienTai * 1.5;
            } else if (phien.tong < 11 && phienTruoc.tong < 11) {
                diemXiu += trongSoHienTai * 1.5;
            }
        }
    }

    const tongDiem = diemTai + diemXiu;
    if (tongDiem === 0) return { duDoanText: "Không xác định", doTinCay: 0 };

    const tyLeTai = (diemTai / tongDiem) * 100;

    if (tyLeTai >= 60) {
        return { duDoanText: "Tài", doTinCay: parseFloat(tyLeTai.toFixed(1)) };
    } else if (tyLeTai <= 40) {
        return { duDoanText: "Xỉu", doTinCay: parseFloat((100 - tyLeTai).toFixed(1)) };
    } else {
        return { duDoanText: "Không rõ ràng", doTinCay: parseFloat(tyLeTai.toFixed(1)) };
    }
}

// ================== WebSocket Handlers ==================
let pingInterval = null;

function onOpen(ws) {
    console.log("✅ Đã kết nối WebSocket:", MINI_TOKEN.wsUrl);
    console.log("📤 Gửi login message...");

    ws.send(JSON.stringify(buildLoginMessage()));

    setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;

        console.log("📤 Đăng ký nhận kết quả Tài/Xỉu...");
        ws.send(JSON.stringify(SUBSCRIBE_TX_RESULT));

        console.log("📤 Đăng ký nhận thông tin Lobby...");
        ws.send(JSON.stringify(SUBSCRIBE_LOBBY));

        // FIX 3: Clear interval cũ trước khi tạo mới (tránh double interval)
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send("2");
                ws.send(JSON.stringify(SUBSCRIBE_TX_RESULT));
                ws.send(JSON.stringify([7, "Simms", lastEventId, 0, { "id": 0 }]));
            }
        }, 10000);
    }, 1000);
}

function onMessage(ws, message) {
    try {
        // LOG TẤT CẢ MESSAGE ĐỂ DEBUG
        console.log("📩 RAW:", message.length > 300 ? message.substring(0, 300) + "..." : message);

        const data = JSON.parse(message);

        if (Array.isArray(data)) {
            if (data.length >= 3 && data[0] === 7 && data[1] === "Simms" && typeof data[2] === 'number') {
                lastEventId = data[2];
            }

            // Log cmd nếu có để debug
            for (let i = 1; i < data.length; i++) {
                if (typeof data[i] === 'object' && data[i] !== null && 'cmd' in data[i]) {
                    console.log(`🔍 CMD nhận được: ${data[i].cmd}`);
                }
            }

            let msgData = null;
            for (let i = 1; i < data.length; i++) {
                if (typeof data[i] === 'object' && data[i] !== null && 'cmd' in data[i]) {
                    msgData = data[i];
                    break;
                }
            }

            if (msgData) {
                // cmd 2000: Room init (taixiuUnbalancedPlugin) - có lịch sử htr[]
                if (msgData.cmd === 2000) {
                    const htr = msgData.htr || msgData.his || msgData.history || null;
                    if (htr && phienLichSu.length === 0) {
                        console.log(`✅ Đã kết nối phòng! (Phiên ${msgData.sid || msgData.rno || '?'})`);
                        console.log("📥 Đang tải lịch sử...");
                        phienLichSu = htr.slice(-20).map(item => {
                            const d1 = item.d1 || item.v1 || 0;
                            const d2 = item.d2 || item.v2 || 0;
                            const d3 = item.d3 || item.v3 || 0;
                            const tong = d1 + d2 + d3;
                            return {
                                phien: item.sid || item.rno || 0,
                                tong, xuc_xac_1: d1, xuc_xac_2: d2, xuc_xac_3: d3,
                                ket_qua: tong >= 11 ? "Tài" : "Xỉu"
                            };
                        });
                        console.log(`📊 Đã nạp ${phienLichSu.length} phiên lịch sử.`);
                    } else if (!htr) {
                        // Log toàn bộ keys để biết field nào chứa lịch sử
                        console.log("🔍 cmd 2000 keys:", Object.keys(msgData).join(", "));
                    }
                }

                // cmd 2006: Kết quả xúc xắc (taixiuUnbalancedPlugin)
                // Fallback thêm cmd 2106 phòng trường hợp server đổi
                if (msgData.cmd === 2006 || msgData.cmd === 2106) {
                    const sid = msgData.sid || msgData.rno || 0;
                    const d1  = msgData.d1  || msgData.v1 || 0;
                    const d2  = msgData.d2  || msgData.v2 || 0;
                    const d3  = msgData.d3  || msgData.v3 || 0;

                    const tong   = d1 + d2 + d3;
                    const ketqua = tong >= 11 ? "Tài" : "Xỉu";

                    phienLichSu.push({
                        phien: sid,
                        tong: tong,
                        xuc_xac_1: d1,
                        xuc_xac_2: d2,
                        xuc_xac_3: d3,
                        ket_qua: ketqua
                    });

                    if (phienLichSu.length > 20) phienLichSu.shift();

                    const { duDoanText, doTinCay } = phanTichDonBay(phienLichSu);

                    latestResult = {
                        "phien": sid,
                        "ket_qua": ketqua,
                        "xuc_xac_1": d1,
                        "xuc_xac_2": d2,
                        "xuc_xac_3": d3,
                        "tong": tong,
                        "phien_hien_tai": sid + 1,
                        "du_doan": duDoanText,
                        "do_tin_cay": doTinCay,
                        "id": "@sewdangcap"
                    };

                    console.log("🎲 CẬP NHẬT KẾT QUẢ:");
                    console.log(JSON.stringify(latestResult, null, 2));
                }
            }
        }

    } catch (error) {
        console.error("❌ Lỗi xử lý message:", error.message);
    }
}

function onClose(ws, code, reason) {
    // FIX 3: Đảm bảo clear interval trước khi reconnect
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    console.log(`🔌 WebSocket đóng. Mã: ${code} - Lý do: ${reason}`);
    console.log("   Kết nối lại sau 5s...");
    // FIX 2: Reset lastEventId khi reconnect để tránh dùng eventId cũ/sai
    lastEventId = 0;
    setTimeout(startWS, 5000);
}

function onError(ws, error) {
    console.error("❌ Lỗi WebSocket:", error.message);
}

function startWS() {
    const wsUrl = MINI_TOKEN.wsUrl;
    console.log("🔄 Bắt đầu kết nối WebSocket:", wsUrl);

    const wsOptions = {
        headers: {
            "Origin": "https://789clubs.im",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
            "Pragma": "no-cache",
            "Cache-Control": "no-cache"
        }
    };

    if (PROXY_URL) {
        wsOptions.agent = new HttpsProxyAgent(PROXY_URL);
    }

    const ws = new WebSocket(wsUrl, wsOptions);

    ws.on('open',    ()             => onOpen(ws));
    ws.on('message', (data)         => onMessage(ws, data.toString()));
    ws.on('close',   (code, reason) => onClose(ws, code, reason.toString()));
    ws.on('error',   (error)        => onError(ws, error));
}

// ================== HTTP SERVER ==================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if ((req.url === '/taixiu' || req.url === '/789club') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latestResult));
        console.log(`🌐 HTTP Request: ${req.url} - Trả về kết quả hiện tại`);
    } else {
        res.writeHead(404);
        res.end("Khong tim thay");
    }
});

// ================== RUN ==================
console.log("🚀 Khởi động hệ thống...");
console.log("code này by phùng huy");
console.log("Telegram @ngphungggiahuyy");
console.log("-".repeat(50));

startWS();
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP Server chạy tại http://localhost:${PORT}/taixiu`);
});
