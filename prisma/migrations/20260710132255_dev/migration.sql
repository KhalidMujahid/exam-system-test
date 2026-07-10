-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT NOT NULL,
    "optionD" TEXT NOT NULL,
    "correctAnswer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "courseId" TEXT NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "rawScore" INTEGER NOT NULL DEFAULT 0,
    "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "checksum" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "courseId" TEXT NOT NULL,
    "questionIds" TEXT[],

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptQuestion" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "AttemptQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptResponse" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedAnswer" TEXT,
    "isCorrect" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Question_questionId_key" ON "Question"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptQuestion_attemptId_questionId_key" ON "AttemptQuestion"("attemptId", "questionId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptQuestion" ADD CONSTRAINT "AttemptQuestion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptQuestion" ADD CONSTRAINT "AttemptQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptResponse" ADD CONSTRAINT "AttemptResponse_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
