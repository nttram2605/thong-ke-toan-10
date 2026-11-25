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
3. Chuẩn hóa số: Chuyển dấu phẩy thập phân kiểu Việt Nam (ví dụ 7,5) thành số thực chuẩn (7.5).`;

    const requestPayload = {
      contents: [
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
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            mode: { type: "STRING", enum: ["raw", "freq"] },
            rawNumbers: { type: "ARRAY", items: { type: "NUMBER" } },
            frequencyTable: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  value: { type: "NUMBER" },
                  frequency: { type: "INTEGER" },
                },
                required: ["value", "frequency"],
              },
            },
            description: { type: "STRING" },
          },
          required: ["mode", "description"],
        },
      },
    };

    const endpoints = [
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    ];

    let response = null;
    let lastErrorText = "";

    for (const url of endpoints) {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      if (response.ok) break;
      lastErrorText = await response.text();
      console.error("API attempt failed:", response.status, lastErrorText);
      if (response.status === 429) break;
    }

    if (!response || !response.ok) {
      const status = response && response.status === 429 ? 429 : 502;
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({
          error: status === 429 ? "Hết lượt AI miễn phí tạm thời" : "Lỗi kết nối dịch vụ AI",
          detail: lastErrorText.slice(0, 200),
        }),
      };
    }

    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

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
