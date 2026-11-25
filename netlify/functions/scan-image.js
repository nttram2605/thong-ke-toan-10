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
4. Chỉ trả về DUY NHẤT một đối tượng JSON hợp lệ (không giải thích thêm) theo đúng mẫu sau:
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

    // Bước 1: Tự động lấy danh sách các model Flash khả dụng trên chính API Key này
    let candidateModels = ["models/gemini-3.8-flash", "models/gemini-flash-latest"];
    try {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const availableFlash = (listData.models || [])
          .filter(
            (m) =>
              m.name &&
              m.name.toLowerCase().includes("flash") &&
              Array.isArray(m.supportedGenerationMethods) &&
              m.supportedGenerationMethods.includes("generateContent")
          )
          .map((m) => m.name);

        if (availableFlash.length > 0) {
          candidateModels = [...new Set([...availableFlash, ...candidateModels])];
        }
      } else {
        const listErr = await listRes.text();
        console.error("ListModels failed:", listRes.status, listErr);
      }
    } catch (e) {
      console.error("ListModels exception:", e.message);
    }

    // Bước 2: Thử gọi lần lượt từng model Flash hợp lệ
    let response = null;
    let lastStatus = 502;
    let lastErrorText = "";

    for (const modelName of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      });

      if (response.ok) break;
      lastStatus = response.status;
      lastErrorText = await response.text();
      console.error(`Model ${modelName} failed (${lastStatus}):`, lastErrorText);

      // Nếu hết lượt miễn phí (429) hoặc Key bị từ chối quyền (403) thì dừng ngay
      if (lastStatus === 429 || lastStatus === 403) break;
    }

    if (!response || !response.ok) {
      const status = lastStatus === 429 ? 429 : 502;
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({
          error:
            lastStatus === 429
              ? "Hết lượt AI miễn phí tạm thời"
              : `Lỗi Google API (${lastStatus}): ${lastErrorText.slice(0, 160)}`,
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
