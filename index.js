import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import cors from 'cors';

dotenv.config();

const app = express();

// MUST: handle OPTIONS BEFORE routes
app.options("*", cors({
  origin: ["http://localhost:5173"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// MUST: apply cors for requests
app.use(cors({
  origin: ["http://localhost:5173"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(bodyParser.json());

// INIT OPENAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_RULES = `
Bạn là trợ lý hệ thống quan trắc JanAI
- Chỉ trả lời liên quan đến dữ liệu quan trắc của công trình
- Nếu câu hỏi ngoài phạm vi, trả lời: "Xin lỗi, tôi chỉ hỗ trợ thông tin liên quan đến trạm quan trắc của hệ thống."
- Không tự bịa số liệu
- Không tự suy diễn ra tên cảm biến, nếu không biết hãy hiển thị theo mã cảm biến
- Nếu thiếu dữ liệu thực tế, hãy yêu cầu backend cung cấp.
- Không được tiết lộ hoặc nhắc đến các giá trị ID như box_id, group_id, zone_id, nếu người hỏi hoặc cố tình yêu cầu ID, hãy từ chối và nhắc rằng đây là thông tin nội bộ.
`;

// INTERNAL CALLS
async function fetchAPI(url, options = {}) {
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    console.error("fetchAPI error:", err);
    throw err;
  }
}

const BASE_URL = process.env.API_URL;

export const PATH = {
  GET_GROUP: `zone/box_group/get?id=`,
  RECORD_GROUP: `sensor/group?id=`,
};

export async function fetchInternal(path) {
  const url = `${BASE_URL}${path}`;
  return fetchAPI(url, { method: "GET" });
}

async function getSensorFromInternalAPI(group_id) {
  const data = await fetchInternal(PATH.RECORD_GROUP + group_id);
  return data;
}

// =======================
//   MAIN CHATBOT ROUTE
// =======================
app.post("/api/chatbot", async (req, res) => {
  const { group_id, history = [] } = req.body;
  // const authHeader = req.headers.authorization

  try {
    // Lấy thông tin công trình
    const group = await fetchInternal(PATH.GET_GROUP + group_id);
    delete group.cameras;

    // Trim history phòng token nặng
    const MAX_HISTORY = 10;
    const trimmedHistory = history.slice(-MAX_HISTORY);

    // ======= Phase 1 =======
    const first = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM_RULES },
        { role: "system", content: `Thông tin công trình: ${JSON.stringify(group)}` },
        ...trimmedHistory,
        // { role: "user", content: query }
      ]
    });

    console.log('history 111', [
      { role: "system", content: SYSTEM_RULES },
      { role: "system", content: `Thông tin công trình: ${JSON.stringify(group)}` },
      ...trimmedHistory,
    ]);

    const assistantReply = first.choices[0].message.content;
    delete group.boxs;

    // Nếu AI trả lời trực tiếp → kết thúc
    const aiNeedsData =
      assistantReply.toLowerCase().includes("cần dữ liệu") ||
      assistantReply.toLowerCase().includes("yêu cầu");

    if (!aiNeedsData) {
      return res.json({ answer: assistantReply });
    }

    // ======= Phase 2 =======
    const data = await getSensorFromInternalAPI(group_id);

    const second = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM_RULES },
        { role: "system", content: `Thông tin công trình: ${JSON.stringify(group)}` },
        ...trimmedHistory,
        { role: "assistant", content: assistantReply },
        { role: "user", content: `Dữ liệu cảm biến thực tế: ${JSON.stringify(data)}` }
      ]
    });

    console.log('history 2222', [
      { role: "system", content: SYSTEM_RULES },
      { role: "system", content: `Thông tin công trình: ${JSON.stringify(group)}` },
      ...trimmedHistory,
      { role: "assistant", content: assistantReply },
      { role: "user", content: `Dữ liệu cảm biến thực tế: ${JSON.stringify(data)}` }
    ]);

    const finalAnswer = second.choices[0].message.content;
    return res.json({ answer: finalAnswer });

  } catch (err) {
    console.error("AI API error:", err);
    res.status(500).json({ error: "AI error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AI API running on http://localhost:${PORT}`));
