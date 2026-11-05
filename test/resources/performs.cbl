       IDENTIFICATION DIVISION.
       PROGRAM-ID. performs.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 I PIC 9(4) VALUE 0.
       01 N PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
       MAIN.
           DISPLAY "start".
           PERFORM PARA-A.
           PERFORM PARA-B 2 TIMES.
           PERFORM VARYING I FROM 1 BY 1 UNTIL I > 2
              ADD 1 TO N
              PERFORM PARA-A
           END-PERFORM.
           PERFORM PARA-A THRU PARA-B.
           DISPLAY "end " N.
           STOP RUN.
       PARA-A.
           ADD 10 TO N.
           PERFORM PARA-B.
       PARA-B.
           ADD 100 TO N.
