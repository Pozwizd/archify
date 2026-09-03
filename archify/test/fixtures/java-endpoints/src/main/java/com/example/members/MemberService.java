package com.example.members;

public interface MemberService {
    MemberResponse create(CreateMemberRequest request);
    MemberResponse findById(Long id);
    MemberResponse update(Long id, UpdateMemberRequest request);
    void delete(Long id);
}
