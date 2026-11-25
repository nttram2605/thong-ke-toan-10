exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Chưa cấu hình GEMINI_API_KEY trên Netlify" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const base64Data = body.imageBase64 || body.base64Data || body.image || body.data;
    const mimeType = body.mimeType || "image/jpeg";

    if (!base64Data) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Thiếu dữ liệu hình ảnh" }),
      };
    }

    const prompt = `Bạn là chuyên gia trích xuất dữ liệu thống kê Toán lớp 10 (CT GDPT 2018) từ hình ảnh.
Hãy phân tích hình ảnh theo các quy tắc sau:
1. Bỏ qua hoàn toàn các số nhiễu: số bài/câu ("Bài 1", "Câu 2", "Ví dụ 3"), số hiệu bảng ("Bảng 5.1"), tên lớp ("10A"), năm học ("2024"), số trang, cột STT (1, 2, 3...) và cột/dòng "Tổng" hoặc "N = ...".
2. Phân loại chế độ:
   - Đặt mode = "freq" nếu ảnh là bảng phân bố tần số (gồm hàng/cột Giá trị x_i và hàng/cột Tần số n_i như: Số học sinh, Số ngày, Số lần, Số cây, Số người, Tần số...).
   - Đặt mode = "raw" nếu ảnh liệt kê dãy số liệu rời rạc không kèm tần số.
3. Chuẩn hóa số: Chuyển dấu phẩy thập phân kiểu Việt Nam (ví dụ 7,5) thành số thực chuẩn (7.5).
4. Chỉ trả về DUY NHẤT một đối tượng JSON hợp lệ (không thêm chữ giải thích bên ngoài) theo đúng cấu trúc:
{
  "mode": "freq",
  "rawNumbers": [],
  "frequencyTable": [{"value": 7.5, "frequency": 4}],
  "description": "Mô tả ngắn gọn bảng số liệu"
}`;

    const contents = [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ];

    // Ưu tiên đúng các model mới nhất mà Google khuyến nghị
    const priorityModels = [
      "models/gemini-3.8-flash",
      "models/gemini-3.5-flash-lite",
      "models/gemini-flash-latest",
      "models/gemini-flash-lite-latest",
    ];

    let discoveredModels = [];
    let hasGemmaBackup = false;

    try {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const allModels = listData.models || [];

        discoveredModels = allModels
          .filter((m) => {
            const name = (m.name || "").toLowerCase();
            const methods = m.supportedGenerationMethods || [];
            if (!methods.includes("generateContent")) return false;
            if (!name.includes("gemini")) return false;
            // Loại bỏ các model cũ bị khóa hoặc model tạo ảnh / giọng nói
            if (
              name.includes("tts") ||
              name.includes("image") ||
              name.includes("embedding") ||
              name.includes("2.5-flash") ||
              name.includes("2.0") ||
              name.includes("1.5")
            ) {
              return false;
            }
            return true;
          })
          .map((m) => m.name);

        hasGemmaBackup = allModels.some(
          (m) =>
            m.name === "models/gemma-3-27b-it" &&
            (m.supportedGenerationMethods || []).includes("generateContent")
        );
      }
    } catch (e) {
      console.error("ListModels warning:", e.message);
    }

    const candidateModels = [...new Set([...priorityModels, ...discoveredModels])];

    let response = null;
    let lastStatus = 502;
    let lastErrorText = "";
    let saw503 = false;

    const tryGeminiModel = async (modelName) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) {
        lastStatus = res.status;
        lastErrorText = await res.text();
        if (res.status === 503) saw503 = true;
        console.error(`Model ${modelName} failed (${res.status}):`, lastErrorText);
      }
      return res;
    };

    for (const modelName of candidateModels) {
      response = await tryGeminiModel(modelName);
      if (response.ok) break;
      if (response.status === 403) break;
    }

    // Nếu gặp 503 (Google quá tải tạm thời), chờ 1.2 giây rồi thử lại
    if ((!response || !response.ok) && saw503) {
      await new Promise((r) => setTimeout(r, 1200));
      for (const retryModel of ["models/gemini-3.8-flash", "models/gemini-flash-latest"]) {
        response = await tryGeminiModel(retryModel);
        if (response.ok) break;
      }
    }

    // Dự phòng cuối cùng bằng Gemma 3 27B nếu toàn bộ Gemini Flash đang bảo trì
    if ((!response || !response.ok) && hasGemmaBackup) {
      const gemmaUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${apiKey}`;
      response = await fetch(gemmaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      });
      if (!response.ok) {
        lastStatus = response.status;
        lastErrorText = await response.text();
        console.error(`Backup Gemma failed (${lastStatus}):`, lastErrorText);
      }
    }

    if (!response || !response.ok) {
      return {
        statusCode: lastStatus === 429 ? 429 : 502,
        headers,
        body: JSON.stringify({
          error:
            lastStatus === 503
              ? "Máy chủ Google AI đang quá tải tạm thời, bạn bấm quét lại sau 5 giây nhé."
              : `Lỗi kết nối Google AI (${lastStatus})`,
        }),
      };
    }

    const result = await response.json();
    let textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    textResponse = textResponse.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    if (!textResponse) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "AI không trả về dữ liệu hợp lệ" }),
      };
    }

    const parsed = JSON.parse(textResponse);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Lỗi xử lý máy chủ: " + err.message }),
    };
  }
};
