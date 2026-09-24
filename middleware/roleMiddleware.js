const restrictTo = (...roles) => {
    return (req, res, next) => {
        // req.user يأتي من الـ authMiddleware الذي يمرر الطلب أولاً
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ 
                status: 'error', 
                message: 'Not Autorized to complete this process(Forbidden for your role)' 
            });
        }
        next();
    };
};

module.exports = restrictTo;