s.on("mcSaveQuestions", payload => {
    if (S.started) return s.emit("mcError", "Không thể sửa khi game đang chạy.");
    
    // Hỗ trợ cả định dạng cũ lẫn mới
    let qs = Array.isArray(payload) ? payload : (payload.questions || []);
    let gPts = typeof payload === 'object' && payload.globalGroupPoints !== undefined ? Number(payload.globalGroupPoints) : 10;
    let iPts = typeof payload === 'object' && payload.globalIndPoints !== undefined ? Number(payload.globalIndPoints) : 10;

    S.questions = qs
      .map(q => ({
        q: String(q.q || "").trim(),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [],
        answer: Number(q.answer),
        groupPoints: gPts, // Áp dụng mức điểm chung cho nhóm
        indPoints: iPts    // Áp dụng mức điểm chung cho cá nhân
      }))
      .filter(q => q.q && q.options.length === 4 && q.options.every(Boolean) && q.answer >= 0 && q.answer <= 3);
    
    s.emit("mcQuestionsSaved", { count: S.questions.length, groupPts: gPts, indPts: iPts });
    bc();
  });
