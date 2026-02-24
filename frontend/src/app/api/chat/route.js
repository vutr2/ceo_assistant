import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  getOrCreateUser,
  saveChatMessage,
  getDailyMetrics,
  getServerSupabase,
} from '../../../lib/supabase';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// In-memory rate limiter: 20 requests per hour per user
const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(userId) {
  const now = Date.now();
  const key = userId;
  const record = rateLimitMap.get(key);

  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (record.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((record.windowStart + RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn };
  }

  record.count += 1;
  return { allowed: true, remaining: RATE_LIMIT - record.count };
}

async function getBusinessContext(dbUserId) {
  const db = getServerSupabase();

  // Get recent metrics (30 days)
  const metrics = await getDailyMetrics(dbUserId, 30);

  // Get recent orders (last 50)
  const { data: orders } = await db
    .from('orders')
    .select('date, customer_name, product, quantity, unit_price, total, status')
    .eq('user_id', dbUserId)
    .order('date', { ascending: false })
    .limit(50);

  // Get recent expenses (last 50)
  const { data: expenses } = await db
    .from('expenses')
    .select('date, category, description, amount, paid_by')
    .eq('user_id', dbUserId)
    .order('date', { ascending: false })
    .limit(50);

  // Get inventory
  const { data: inventory } = await db
    .from('inventory')
    .select('product_name, quantity_in, quantity_out, stock_remaining, date')
    .eq('user_id', dbUserId)
    .order('date', { ascending: false })
    .limit(30);

  // Get employees
  const { data: employees } = await db
    .from('employees')
    .select('employee_name, role, department, salary, status')
    .eq('user_id', dbUserId)
    .limit(50);

  // Calculate summaries
  const today = metrics.length > 0 ? metrics[metrics.length - 1] : null;
  const totalRevenue = metrics.reduce((s, m) => s + (m.revenue || 0), 0);
  const totalExpenses = metrics.reduce((s, m) => s + (m.expenses || 0), 0);
  const totalProfit = metrics.reduce((s, m) => s + (m.profit || 0), 0);
  const avgMargin = metrics.length > 0
    ? (metrics.reduce((s, m) => s + (m.profit_margin || 0), 0) / metrics.length).toFixed(1)
    : 0;

  let context = `=== DỮ LIỆU KINH DOANH CỦA NGƯỜI DÙNG ===\n\n`;

  // Summary
  context += `--- TỔNG QUAN 30 NGÀY GẦN NHẤT ---\n`;
  context += `Tổng doanh thu: ${totalRevenue.toLocaleString('vi-VN')} VNĐ\n`;
  context += `Tổng chi phí: ${totalExpenses.toLocaleString('vi-VN')} VNĐ\n`;
  context += `Tổng lợi nhuận: ${totalProfit.toLocaleString('vi-VN')} VNĐ\n`;
  context += `Biên lợi nhuận trung bình: ${avgMargin}%\n`;
  if (today) {
    context += `\nHôm nay (${today.date}):\n`;
    context += `  Doanh thu: ${(today.revenue || 0).toLocaleString('vi-VN')} VNĐ\n`;
    context += `  Chi phí: ${(today.expenses || 0).toLocaleString('vi-VN')} VNĐ\n`;
    context += `  Lợi nhuận: ${(today.profit || 0).toLocaleString('vi-VN')} VNĐ\n`;
    context += `  Biên LN: ${today.profit_margin || 0}%\n`;
  }

  // Daily metrics trend
  if (metrics.length > 0) {
    context += `\n--- XU HƯỚNG DOANH THU THEO NGÀY ---\n`;
    metrics.slice(-14).forEach((m) => {
      context += `${m.date}: DT=${(m.revenue || 0).toLocaleString('vi-VN')}, CP=${(m.expenses || 0).toLocaleString('vi-VN')}, LN=${(m.profit || 0).toLocaleString('vi-VN')}, Biên=${m.profit_margin || 0}%\n`;
    });
  }

  // Orders
  if (orders && orders.length > 0) {
    context += `\n--- ĐƠN HÀNG GẦN NHẤT (${orders.length} đơn) ---\n`;
    orders.slice(0, 20).forEach((o) => {
      context += `${o.date}: ${o.customer_name} - ${o.product} x${o.quantity} @ ${(o.unit_price || 0).toLocaleString('vi-VN')} = ${(o.total || 0).toLocaleString('vi-VN')} VNĐ [${o.status}]\n`;
    });
  }

  // Expenses
  if (expenses && expenses.length > 0) {
    context += `\n--- CHI PHÍ GẦN NHẤT (${expenses.length} khoản) ---\n`;
    expenses.slice(0, 20).forEach((e) => {
      context += `${e.date}: [${e.category}] ${e.description} - ${(e.amount || 0).toLocaleString('vi-VN')} VNĐ (${e.paid_by})\n`;
    });
  }

  // Inventory
  if (inventory && inventory.length > 0) {
    context += `\n--- KHO HÀNG ---\n`;
    inventory.slice(0, 15).forEach((i) => {
      context += `${i.product_name}: Nhập=${i.quantity_in}, Xuất=${i.quantity_out}, Tồn=${i.stock_remaining}\n`;
    });
  }

  // Employees
  if (employees && employees.length > 0) {
    context += `\n--- NHÂN SỰ (${employees.length} người) ---\n`;
    employees.forEach((e) => {
      context += `${e.employee_name} - ${e.role} (${e.department}) - Lương: ${(e.salary || 0).toLocaleString('vi-VN')} VNĐ [${e.status}]\n`;
    });
  }

  return context;
}

const SYSTEM_PROMPT = `Bạn là AI Assistant cho CEO Dashboard — một trợ lý thông minh giúp các chủ doanh nghiệp nhỏ và vừa tại Việt Nam phân tích dữ liệu kinh doanh và đưa ra lời khuyên.

Vai trò của bạn:
- Phân tích dữ liệu doanh thu, chi phí, lợi nhuận, kho hàng, nhân sự
- Đưa ra nhận xét về xu hướng kinh doanh
- Gợi ý cách tối ưu chi phí, tăng doanh thu, cải thiện biên lợi nhuận
- Cảnh báo các vấn đề tiềm ẩn (chi phí tăng đột biến, doanh thu giảm, tồn kho cao/thấp)
- Trả lời câu hỏi cụ thể về dữ liệu kinh doanh

Quy tắc:
- Trả lời bằng tiếng Việt
- Ngắn gọn, đi thẳng vào vấn đề
- Dùng số liệu cụ thể từ dữ liệu được cung cấp
- Khi đưa ra lời khuyên, hãy thực tế và khả thi cho doanh nghiệp nhỏ
- Nếu không có đủ dữ liệu để trả lời, hãy nói rõ
- Format số tiền theo VNĐ
- Không bịa dữ liệu — chỉ phân tích dựa trên những gì có sẵn`;

export async function POST(request) {
  try {
    const { userId, message, chatHistory } = await request.json();

    if (!userId || !message) {
      return NextResponse.json(
        { error: 'Missing userId or message' },
        { status: 400 },
      );
    }

    // Get user and check plan
    const dbUser = await getOrCreateUser(userId, '', '');

    const plan = dbUser.plan || 'free';
    const isProActive =
      plan === 'pro' ||
      (plan === 'pro_cancelled' &&
        dbUser.plan_expires_at &&
        new Date(dbUser.plan_expires_at) > new Date());

    if (!isProActive) {
      return NextResponse.json(
        { error: 'AI Chat chỉ dành cho gói Pro. Vui lòng nâng cấp.' },
        { status: 403 },
      );
    }

    // Rate limiting: 20 requests per hour per user
    const rateLimit = checkRateLimit(userId);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: `Bạn đã vượt quá giới hạn 20 tin nhắn/giờ. Vui lòng thử lại sau ${rateLimit.resetIn} phút.` },
        { status: 429 },
      );
    }

    // Save user message
    await saveChatMessage(dbUser.id, 'user', message);

    // Get business data context
    const businessContext = await getBusinessContext(dbUser.id);

    // Build conversation messages for Claude
    const messages = [];

    // Add recent chat history (last 10 messages for context)
    if (chatHistory && chatHistory.length > 0) {
      const recent = chatHistory.slice(-10);
      for (const msg of recent) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    // Add current user message with business context
    messages.push({
      role: 'user',
      content: `${businessContext}\n\n--- CÂU HỎI CỦA CEO ---\n${message}`,
    });

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0]?.text || 'Không có phản hồi từ AI.';

    // Save AI response
    await saveChatMessage(dbUser.id, 'assistant', reply);

    return NextResponse.json({ message: reply });
  } catch (error) {
    console.error('Chat API error:', error);

    if (error?.status === 401) {
      return NextResponse.json(
        { error: 'Lỗi cấu hình API key. Vui lòng liên hệ quản trị viên.' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: 'Lỗi khi xử lý yêu cầu. Vui lòng thử lại.' },
      { status: 500 },
    );
  }
}
